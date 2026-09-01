import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { recCatalogData } from "../src/config/rec-catalog.data.js";
import {
  FAIL_SAFE_ROUTING,
  REC_ROUTING,
  SEO_GEO_ENGINE_PRODUCT_IDS,
  routingFor,
  type RecRouting,
} from "../src/config/rec-routing-map.js";
import {
  DEFAULT_REC_OWNER,
  KNOWN_ACTION_KINDS,
  KNOWN_FIX_ACTIONS,
  KNOWN_REC_OWNERS,
} from "../src/routable-recommendation-contract.js";
import { evaluateRecommendations } from "../src/recommend.js";

/**
 * T-A4 / SCRUM-257's acceptance gate: the `rec_id -> routing` table in
 * `src/config/rec-routing-map.ts` must cover `rec-catalog.data.ts` exactly.
 * Originally 75 rows; SCRUM-382 added the 76th ("SEO-11") so `og_image` has a
 * real producer — see this file's "every FixAction member is reachable" block below.
 *
 * There are two independent guards on that, deliberately:
 *
 *  1. `REC_ROUTING`'s own `satisfies Record<CatalogRecId, RecRouting>` makes a
 *     missing row a `tsc` error and a stray row an excess-property `tsc` error;
 *  2. this file re-asserts both directions at RUNTIME, because `vitest` does
 *     not typecheck — `npx vitest run` alone would never see the type error.
 *
 * Neither subsumes the other: (1) fails `npm run build` and `tsc --noEmit`,
 * (2) fails the test run. A new catalog row without a mapping trips both.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const WORKFLOWS_TS = path.join(REPO_ROOT, "apps/agent-server/src/wiring/workflows.ts");

/**
 * Contract Rule 2 says `engineProductId` "must come from `KNOWN_PRODUCT_IDS`
 * (`apps/agent-server/src/wiring/workflows.ts`) ... enforced by a test on
 * whichever side does the mapping" — this side.
 *
 * That list is READ AS TEXT rather than imported. Two reasons, both real:
 * `apps/agent-server` is an application that depends on this package, so
 * importing it here would invert the dependency graph; and `workflows.ts`'s
 * module body imports all thirteen agent workflow factories, which a mapping
 * test has no business loading. Parsing the literal keeps the pin against the
 * LIVE source (a rename there fails here) with neither cost.
 */
function parseKnownProductIds(): string[] {
  const src = readFileSync(WORKFLOWS_TS, "utf8");
  const block = /export const KNOWN_PRODUCT_IDS = \[([\s\S]*?)\] as const;/.exec(src);
  if (!block) throw new Error(`KNOWN_PRODUCT_IDS literal not found in ${WORKFLOWS_TS}`);
  const ids = [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  if (ids.length === 0) throw new Error(`KNOWN_PRODUCT_IDS parsed empty from ${WORKFLOWS_TS}`);
  return ids;
}

const catalogRecIds = Object.keys(recCatalogData);
const routedRecIds = Object.keys(REC_ROUTING);
const rows = Object.entries(REC_ROUTING) as [string, RecRouting][];

describe("rec-routing-map: catalog coverage (SCRUM-257 acceptance)", () => {
  it("the catalog is 76 records, recounted here rather than assumed", () => {
    // Independent recount at runtime, off the parsed module rather than off a
    // grep of the source: three prior rounds landed on 75 by three different
    // methods, and this pins the number in the same place the mapping lives.
    // SCRUM-382 added the 76th record ("SEO-11") to give `og_image` a real producer.
    expect(catalogRecIds).toHaveLength(76);
    expect(new Set(catalogRecIds).size).toBe(76); // no duplicate keys silently collapsing
    // Each record's own `id` field agrees with its key — otherwise a mapping
    // keyed by the object key could be routing a record that calls itself something else.
    for (const [key, record] of Object.entries(recCatalogData)) {
      expect((record as { id: string }).id).toBe(key);
    }
  });

  it("every catalog record has a routing row — a new catalog row without a mapping fails here", () => {
    const unmapped = catalogRecIds.filter((id) => !(id in REC_ROUTING));
    expect(unmapped).toEqual([]);
    expect(routedRecIds).toHaveLength(76);
  });

  it("every routing row names a real catalog record — no rows for rec_ids that no longer exist", () => {
    const orphaned = routedRecIds.filter((id) => !(id in recCatalogData));
    expect(orphaned).toEqual([]);
  });

  it("the two key sets are identical, in both directions at once", () => {
    expect([...routedRecIds].sort()).toEqual([...catalogRecIds].sort());
  });
});

describe("rec-routing-map: every value is a contract union member", () => {
  it("every fixAction is a KNOWN_FIX_ACTIONS member", () => {
    const bad = rows.filter(([, r]) => !(KNOWN_FIX_ACTIONS as readonly string[]).includes(r.fixAction));
    expect(bad.map(([id]) => id)).toEqual([]);
  });

  it("every actionKind is a KNOWN_ACTION_KINDS member", () => {
    const bad = rows.filter(([, r]) => !(KNOWN_ACTION_KINDS as readonly string[]).includes(r.actionKind));
    expect(bad.map(([id]) => id)).toEqual([]);
  });

  it("every owner is a KNOWN_REC_OWNERS member", () => {
    const bad = rows.filter(([, r]) => !(KNOWN_REC_OWNERS as readonly string[]).includes(r.owner));
    expect(bad.map(([id]) => id)).toEqual([]);
  });
});

describe("rec-routing-map: contract Rules 2 and 3 (engineProductId)", () => {
  const knownProductIds = parseKnownProductIds();

  it("parses a plausible KNOWN_PRODUCT_IDS out of apps/agent-server/src/wiring/workflows.ts", () => {
    // Guards the guard: a regex that silently matched nothing would make every
    // assertion below vacuously true.
    expect(knownProductIds.length).toBeGreaterThanOrEqual(10);
    expect(knownProductIds).toContain("seo-geo-agent");
  });

  it("SEO_GEO_ENGINE_PRODUCT_IDS is a subset of the live KNOWN_PRODUCT_IDS (Rule 2)", () => {
    const notKnown = SEO_GEO_ENGINE_PRODUCT_IDS.filter((id) => !knownProductIds.includes(id));
    expect(notKnown).toEqual([]);
  });

  it("Rule 3: every karos_agent row carries an engineProductId, and it is a KNOWN_PRODUCT_IDS member", () => {
    const offenders = rows
      .filter(([, r]) => r.owner === "karos_agent")
      .filter(([, r]) => r.engineProductId === undefined || !knownProductIds.includes(r.engineProductId));
    expect(offenders.map(([id]) => id)).toEqual([]);
  });

  it("no non-karos_agent row carries an engineProductId (the contract only trusts it under karos_agent)", () => {
    const offenders = rows.filter(([, r]) => r.owner !== "karos_agent" && r.engineProductId !== undefined);
    expect(offenders.map(([id]) => id)).toEqual([]);
  });

  it("Rule 1: no engineProductId was derived from a product_ref.folder that is not an engine product", () => {
    // BOTH-08's folder is "landing-page" and this repo ships a `landing-builder-agent`; the
    // contract forbids deriving one from the other, so the row must carry no engineProductId.
    const both08: RecRouting = REC_ROUTING["BOTH-08"];
    expect(both08.engineProductId).toBeUndefined();
    expect(both08.owner).toBe("client_manual");
  });
});

describe("rec-routing-map: the fail-safe", () => {
  it("FAIL_SAFE_ROUTING matches the contract's DEFAULT_REC_OWNER and never routes to a product", () => {
    expect(FAIL_SAFE_ROUTING.owner).toBe(DEFAULT_REC_OWNER);
    expect(FAIL_SAFE_ROUTING.owner).toBe("client_manual");
    expect(FAIL_SAFE_ROUTING.fixAction).toBe("manual");
    expect(FAIL_SAFE_ROUTING.actionKind).toBe("guided_manual");
    expect(FAIL_SAFE_ROUTING.engineProductId).toBeUndefined();
  });

  it("routingFor an unknown rec_id fails safe rather than throwing or guessing", () => {
    expect(routingFor("NOT-A-REC-99")).toEqual(FAIL_SAFE_ROUTING);
  });

  it("routingFor a real rec_id returns that record's own row, not the fail-safe", () => {
    expect(routingFor("SEO-02")).toEqual(REC_ROUTING["SEO-02"]);
  });
});

describe("rec-routing-map: the classification is a reading of the catalog, not one default applied 75 times", () => {
  it("all three owners and all four action kinds are actually used", () => {
    expect(new Set(rows.map(([, r]) => r.owner))).toEqual(new Set(["karos_agent", "karos_tool", "client_manual"]));
    expect(new Set(rows.map(([, r]) => r.actionKind))).toEqual(new Set(["one_click", "review_approve", "connect", "guided_manual"]));
  });

  it("no single owner or actionKind swallows the catalog", () => {
    for (const owner of ["karos_agent", "karos_tool", "client_manual"]) {
      const n = rows.filter(([, r]) => r.owner === owner).length;
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(rows.length);
    }
  });

  it("one_click is reserved for machine-appliable fix types (RFC-09 §1)", () => {
    // "one_click — the fix is both agent-direct (we generate it) and in MACHINE_APPLIABLE".
    // A one_click row whose fixAction is "manual" would be a contradiction in terms.
    const contradictions = rows.filter(([, r]) => r.actionKind === "one_click" && r.fixAction === "manual");
    expect(contradictions.map(([id]) => id)).toEqual([]);
  });

  it("guided_manual and client_manual agree: if the client ships it, the client owns it", () => {
    const mismatched = rows.filter(([, r]) => (r.actionKind === "guided_manual") !== (r.owner === "client_manual"));
    expect(mismatched.map(([id]) => id)).toEqual([]);
  });

  it("routes to more than one engine product — the mapping is not 'seo-geo-agent' stamped everywhere", () => {
    const used = new Set<string>(rows.flatMap(([, r]) => (r.engineProductId === undefined ? [] : [r.engineProductId])));
    expect(used.size).toBeGreaterThan(1);
    expect(used).toContain("blog-agent");
    expect(used).toContain("linkedin-agent");
    expect(used).toContain("reddit-agent");
  });

  it("the two catalog rows whose product_ref names a live non-a3 engine agent route to that agent, not to a3", () => {
    // GEO-20 and BOTH-13 both carry product_ref {id: e14, folder: blog-agent, status: live}.
    expect(REC_ROUTING["GEO-20"].engineProductId).toBe("blog-agent");
    expect(REC_ROUTING["BOTH-13"].engineProductId).toBe("blog-agent");
    expect(REC_ROUTING["GEO-31"].engineProductId).toBe("linkedin-agent");
  });

  it("every catalog row with a null product_ref is client_manual — we never route a fix to a product that is not named", () => {
    const nullRefIds = Object.entries(recCatalogData)
      .filter(([, record]) => (record as { product_ref?: unknown }).product_ref === null)
      .map(([id]) => id);
    expect(nullRefIds.length).toBeGreaterThan(0);
    for (const id of nullRefIds) {
      expect([id, REC_ROUTING[id as keyof typeof REC_ROUTING].owner]).toEqual([id, "client_manual"]);
    }
  });
});

describe("recommend.ts enrichment (the fields now leaving the engine)", () => {
  const fired = evaluateRecommendations({
    "SEO-02": [{ norm: 0.2, weight: 5, normalization: "ratio_clamp" }],
    "GEO-20": [{ norm: 0.2, weight: 5, normalization: "ratio_clamp" }],
    "GEO-15": [{ norm: 0.2, weight: 5, normalization: "ratio_clamp" }],
  });
  const bySeo02 = fired.find((f) => f.recId === "SEO-02")!;
  const byGeo20 = fired.find((f) => f.recId === "GEO-20")!;
  const byGeo15 = fired.find((f) => f.recId === "GEO-15")!;

  it("attaches the routing to every fired recommendation", () => {
    for (const rec of fired) {
      const routing = REC_ROUTING[rec.recId as keyof typeof REC_ROUTING];
      expect(rec.fixAction).toBe(routing.fixAction);
      expect(rec.actionKind).toBe(routing.actionKind);
      expect(rec.owner).toBe(routing.owner);
    }
  });

  it("carries the catalog's check/lever/productRef, which the old ten-field wire shape discarded", () => {
    expect(bySeo02.check).toContain("char count");
    expect(bySeo02.lever).toBe("SEO");
    expect(bySeo02.productRef).toEqual({ id: "a3", folder: "seo-geo", status: "live" });
    // GEO-20's product_ref points at a different lab product than a3.
    expect(byGeo20.productRef).toEqual({ id: "e14", folder: "blog-agent", status: "live" });
    // GEO-15 has product_ref: null in the catalog — emitted as null, never invented.
    expect(byGeo15.productRef).toBeNull();
    expect(byGeo15.lever).toBe("GEO");
  });

  it("emits engineProductId only for karos_agent rows, and omits the key entirely otherwise", () => {
    expect(bySeo02.owner).toBe("karos_agent");
    expect(bySeo02.engineProductId).toBe("seo-geo-agent");
    expect(byGeo20.engineProductId).toBe("blog-agent");
    expect(byGeo15.owner).toBe("client_manual");
    expect("engineProductId" in byGeo15).toBe(false); // absent, not `undefined`
  });

  it("leaves the ten scoring fields untouched — enrichment is attachment, not input", () => {
    expect(bySeo02.fireState).toBe("fail");
    expect(bySeo02.worstNorm).toBe(0.2);
    expect(bySeo02.scoreLift).toBeCloseTo(4); // (1-0.2)*5
    expect(bySeo02.impact).toBe("high");
    expect(bySeo02.effort).toBe("quick");
    expect(bySeo02.delivery).toBe("agent-direct");
    expect(bySeo02.hardOverride).toBe(false);
    // 100*3*3 + 20*(1-0.2) + 10 + 5*2 - 0
    expect(bySeo02.priorityScore).toBeCloseTo(936);
  });

  it("never emits targetPlatform, because no catalog record supplies one", () => {
    for (const rec of fired) expect("targetPlatform" in rec).toBe(false);
  });
});

describe("rec-routing-map: every FixAction member is reachable (SCRUM-382 acceptance)", () => {
  /**
   * `FixAction` (`routable-recommendation-contract.ts`) advertises nine members. Before
   * SCRUM-382, `og_image` had zero catalog rows routing to it: `KNOWN_FIX_ACTIONS` is a
   * type-level union, and a member can sit in that union forever with no real-world
   * producer — `tsc` has no way to see that, because the union is satisfied by the OTHER
   * eight rows just fine. This is the runtime check that closes that blind spot: for every
   * `FixAction` member, at least one live `REC_ROUTING` row must actually use it.
   *
   * This is deliberately independent of the coverage tests above (which only prove the two
   * key sets — catalog ids and routed ids — match each other, never that every fixAction
   * *value* the table is allowed to emit is actually emitted somewhere).
   */
  it("every KNOWN_FIX_ACTIONS member has at least one REC_ROUTING row that uses it", () => {
    const usedFixActions = new Set(rows.map(([, r]) => r.fixAction));
    const unreachable = KNOWN_FIX_ACTIONS.filter((action) => !usedFixActions.has(action));
    expect(unreachable).toEqual([]);
  });

  it("og_image specifically has a real producer — the SCRUM-382 regression this ticket exists to close", () => {
    const ogImageRows = rows.filter(([, r]) => r.fixAction === "og_image").map(([id]) => id);
    expect(ogImageRows.length).toBeGreaterThan(0);
    expect(ogImageRows).toContain("SEO-11");
  });
});
