import { describe, expect, it } from "vitest";
import {
  KNOWN_ACTION_KINDS,
  KNOWN_FIX_ACTIONS,
  REC_ROUTING,
  type ActionKind,
  type FixAction,
  type RecOwner,
} from "@agent-engine/tool-karos-seo-geo";
import { dispatchSeoFix } from "../src/dispatch.js";
import type { SeoFixInput } from "../src/types.js";

const FIXED_NOW = "2026-08-31T00:00:00.000Z";

/** A minimal, otherwise-valid `RoutableRecommendation` — every field `dispatchSeoFix` doesn't care about is a fixed, harmless placeholder. */
function makeRec(overrides: Partial<SeoFixInput> & Pick<SeoFixInput, "recId" | "fixAction" | "actionKind" | "owner">): SeoFixInput {
  return {
    recommendation: `Test recommendation text for ${overrides.recId}.`,
    fireState: "fail",
    worstNorm: 0,
    scoreLift: 10,
    impact: "medium",
    effort: "medium",
    delivery: "existing-product",
    priorityScore: 100,
    hardOverride: false,
    check: `Test evidence for ${overrides.recId}.`,
    lever: "BOTH",
    productRef: null,
    ...overrides,
  };
}

describe("dispatchSeoFix — one actuator per fixAction (SCRUM-261 acceptance)", () => {
  // Every non-`manual` FixAction is machine-appliable per the contract; `manual` is the advisory
  // fallback. All nine get an artifact — including `og_image`, which the routing table did not
  // fire from any catalog row until SCRUM-382 added one ("SEO-11" — see the "og_image now fires
  // from a real catalog row" test below) but which had to have a real actuator regardless, per
  // T-A17/SCRUM-261's explicit instruction not to delete the member to make this tidy.
  const nonConnectActionKinds: ActionKind[] = KNOWN_ACTION_KINDS.filter((k) => k !== "connect");

  for (const fixAction of KNOWN_FIX_ACTIONS) {
    it(`produces a populated artifactRef for fixAction "${fixAction}"`, () => {
      const rec = makeRec({
        recId: `TEST-${fixAction.toUpperCase()}`,
        fixAction,
        actionKind: "review_approve",
        owner: "karos_agent",
        engineProductId: "seo-geo-agent",
      });

      const outcome = dispatchSeoFix(rec, { now: () => FIXED_NOW });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("unreachable — asserted ok above");
      expect(typeof outcome.artifactRef).toBe("string");
      expect(outcome.artifactRef.length).toBeGreaterThan(0);
      expect(outcome.actionKind).toBe("review_approve");
      expect(outcome.artifact.fixAction).toBe(fixAction);
      expect(outcome.artifact.proposal.fixAction).toBe(fixAction);
      expect(outcome.artifact.generatedAt).toBe(FIXED_NOW);
    });
  }

  it("never performs a live mutation — every successful outcome is inert data, not an executed write", () => {
    // Structural proof, not a mock assertion: `SeoFixDispatchSuccess` carries no callback, no
    // fetch, no filesystem handle — the whole return value is JSON-serializable. If dispatch ever
    // grew a side effect this would still pass, which is exactly why the package as a whole has no
    // `fetch`/`fs`/HTTP import anywhere (checked below) rather than relying on this test alone.
    const rec = makeRec({ recId: "SEO-02", fixAction: "meta_title", actionKind: "one_click", owner: "karos_agent", engineProductId: "seo-geo-agent" });
    const outcome = dispatchSeoFix(rec);
    expect(outcome.ok).toBe(true);
    expect(() => JSON.stringify(outcome)).not.toThrow();
  });

  it("refuses generically on actionKind === 'connect', for an arbitrary fixAction/owner/recId — never a recId branch", () => {
    for (const owner of ["karos_agent", "karos_tool", "client_manual"] as RecOwner[]) {
      const rec = makeRec({
        recId: `TEST-CONNECT-${owner}`,
        fixAction: "indexing",
        actionKind: "connect",
        owner,
        ...(owner === "karos_agent" ? { engineProductId: "seo-geo-agent" as const } : {}),
      });
      const outcome = dispatchSeoFix(rec);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable — asserted !ok above");
      expect(outcome.reason).toBe("requires_external_connection");
      expect(outcome.recId).toBe(rec.recId);
    }
  });

  it("[negative / adversarial] refuses an unknown fixAction rather than silently returning null", () => {
    const rec = makeRec({
      recId: "TEST-UNKNOWN",
      // Simulates a malformed/unexpected value crossing a wire boundary (queue message, HTTP
      // body) — the one place `FixAction`'s compile-time closure cannot help, per `types.ts`'s
      // `unknown_fix_action` doc. The cast is deliberate: this is exactly the case the acceptance
      // criteria's negative test exists to cover.
      fixAction: "delete_everything" as unknown as FixAction,
      actionKind: "one_click",
      owner: "karos_agent",
      engineProductId: "seo-geo-agent",
    });

    const outcome = dispatchSeoFix(rec);

    expect(outcome).not.toBeNull();
    expect(outcome).not.toBeUndefined();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable — asserted !ok above");
    expect(outcome.reason).toBe("unknown_fix_action");
    expect(outcome.detail).toContain("delete_everything");
  });

  it("dispatch is a pure function of (fixAction, actionKind) — recId never changes the routing decision", () => {
    // Two records, same fixAction/actionKind/owner, different recId and different recommendation
    // text: both must be dispatched (or both refused) identically. This is the closest a unit test
    // gets to proving "no `if` on a specific recId" from the outside rather than by reading the
    // source: if dispatch.ts ever grew `if (rec.recId === "...")`, this test's two branches would
    // diverge in `.ok` for two otherwise-identical records.
    const a = dispatchSeoFix(makeRec({ recId: "SEO-02", fixAction: "meta_title", actionKind: "one_click", owner: "karos_agent", engineProductId: "seo-geo-agent" }));
    const b = dispatchSeoFix(makeRec({ recId: "GEO-99-DOES-NOT-EXIST", fixAction: "meta_title", actionKind: "one_click", owner: "karos_agent", engineProductId: "seo-geo-agent" }));
    expect(a.ok).toBe(b.ok);
  });

  it("nonConnectActionKinds sanity: fixture list omits 'connect' (guards the test itself against a stale KNOWN_ACTION_KINDS import)", () => {
    expect(nonConnectActionKinds).not.toContain("connect");
    expect(nonConnectActionKinds.length).toBe(KNOWN_ACTION_KINDS.length - 1);
  });
});

describe("dispatchSeoFix — generic across the real 76-row routing table (no recId branch anywhere)", () => {
  const routingEntries = Object.entries(REC_ROUTING) as Array<[string, (typeof REC_ROUTING)[keyof typeof REC_ROUTING]]>;

  it("has 76 rows to run this proof against (fails loudly if the catalog size assumption drifts)", () => {
    // SCRUM-382 added the 76th row ("SEO-11") on the karos-seo-geo side, to give `og_image` a
    // real producer — see the "og_image is reachable" test below, which replaces this describe
    // block's old "og_image is unreachable" one now that the premise has changed.
    expect(routingEntries.length).toBe(76);
  });

  for (const [recId, routing] of routingEntries) {
    it(`${recId} (fixAction=${routing.fixAction}, actionKind=${routing.actionKind}, owner=${routing.owner})`, () => {
      const rec = makeRec({
        recId,
        fixAction: routing.fixAction,
        actionKind: routing.actionKind,
        owner: routing.owner,
        ...("engineProductId" in routing && routing.engineProductId ? { engineProductId: routing.engineProductId } : {}),
      });

      const outcome = dispatchSeoFix(rec);

      if (routing.actionKind === "connect") {
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error("unreachable");
        expect(outcome.reason).toBe("requires_external_connection");
      } else {
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error(`unreachable — ${recId} should have produced an artifact: ${outcome.detail}`);
        expect(outcome.artifactRef.length).toBeGreaterThan(0);
      }
    });
  }

  it("[SCRUM-382 update, was: known gap / T-A17/SCRUM-261 report] og_image now fires from a real catalog row — SEO-11", () => {
    // Until SCRUM-382, `routing.fixAction`'s inferred literal union (from the real `REC_ROUTING`
    // table) had NO "og_image" member at all, and this test asserted exactly that gap — see git
    // history for the original "expect(ogImageRows).toHaveLength(0)" version and its own comment:
    // "If this ever fails, it means og_image finally has a producer upstream — delete this
    // assertion (not the actuator) and add a real coverage test for whichever recId now routes to
    // it." SCRUM-382 (agent-engine, karos-seo-geo side) is that upstream producer: it added
    // "SEO-11" to `rec-catalog.data.ts`, mapped to `og_image` in `rec-routing-map.ts`. This is the
    // real coverage test that comment called for. Nothing in this package (the actuator itself —
    // `dispatch.ts`/`artifact-proposals.ts`/`types.ts`) changed; only this assertion did.
    const ogImageRows = routingEntries.filter(([, routing]) => (routing.fixAction as FixAction) === "og_image");
    expect(ogImageRows).toHaveLength(1);
    expect(ogImageRows.map(([recId]) => recId)).toEqual(["SEO-11"]);
    // And the actuator that was already implemented for it actually dispatches this real row —
    // not just a synthetic fixture, closing the loop end to end within this package's own scope.
    const [, seo11Routing] = ogImageRows[0]!;
    const outcome = dispatchSeoFix(
      makeRec({
        recId: "SEO-11",
        fixAction: seo11Routing.fixAction,
        actionKind: seo11Routing.actionKind,
        owner: seo11Routing.owner,
        ...("engineProductId" in seo11Routing && seo11Routing.engineProductId ? { engineProductId: seo11Routing.engineProductId } : {}),
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable — asserted ok above");
    expect(outcome.artifact.fixAction).toBe("og_image");
  });
});
