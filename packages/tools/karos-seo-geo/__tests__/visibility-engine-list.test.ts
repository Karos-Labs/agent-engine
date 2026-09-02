import { describe, expect, it } from "vitest";
import {
  SEO_GEO_CAPTURE_ENGINES,
  SEO_GEO_VISIBILITY_ENGINES,
  SEO_GEO_VISIBILITY_ENGINE_DECISION,
  SEO_GEO_VISIBILITY_ENGINE_SPECS,
  type SeoGeoVisibilityEngine,
} from "../src/types.js";
import { ScoreInputSchema } from "../src/schemas.js";
import { captureConfigData } from "../src/config/capture-config.data.js";

/**
 * SCRUM-396 acceptance: "a test asserts the four sources cannot drift (derive
 * from one constant, do not re-list)".
 *
 * The point of every assertion here is that it fails when a source starts
 * carrying its OWN copy of the engine keys. So these tests deliberately do not
 * spell the keys out either — except in the two places where a literal is the
 * assertion (the two engines the ticket added, and the frozen hash), because
 * "derived from the constant" is trivially true of a value read from the
 * constant.
 */
describe("SCRUM-396: the visibility-engine list has one source", () => {
  it("ratifies seven accepted engines, adding aimode and google_aio to the five that shipped", () => {
    // The one literal worth writing: the ticket's actual change. If someone
    // narrows the list back, this says which two went missing.
    expect([...SEO_GEO_VISIBILITY_ENGINES]).toEqual(["chatgpt", "perplexity", "gemini", "claude", "copilot", "aimode", "google_aio"]);
    expect(SEO_GEO_VISIBILITY_ENGINES).toHaveLength(7);
  });

  it("keeps `claude` accepted — v2 deferred the column, it never removed it", () => {
    // Not cosmetic. `claude` is the one engine this repo measures first-party
    // (capture-adapters/claude.ts) and the reason v2 deferred it — its routed
    // provider has no Claude endpoint — is not this repo's constraint. Dropping
    // it deletes a working measured column. See the decision record.
    expect(SEO_GEO_VISIBILITY_ENGINES).toContain("claude");
    expect(SEO_GEO_CAPTURE_ENGINES).toContain("claude");
    expect(SEO_GEO_VISIBILITY_ENGINE_DECISION.claudeKept).toBe(true);
  });

  it("specs every accepted engine and nothing else — the anti-drift guarantee the typechecker enforces", () => {
    // `SEO_GEO_VISIBILITY_ENGINE_SPECS` is a Record over the engine union, so
    // this cannot fail without the build failing first. Asserted anyway,
    // because the value of the guarantee is that it is checked, and a future
    // refactor to a looser type (Record<string, …>) would silently lose it
    // while leaving every other test in this file passing.
    expect(Object.keys(SEO_GEO_VISIBILITY_ENGINE_SPECS).sort()).toEqual([...SEO_GEO_VISIBILITY_ENGINES].sort());
  });

  it("derives the captured list from the specs rather than re-listing it", () => {
    const fromSpecs = SEO_GEO_VISIBILITY_ENGINES.filter((engine) => SEO_GEO_VISIBILITY_ENGINE_SPECS[engine].captured);
    expect([...SEO_GEO_CAPTURE_ENGINES]).toEqual(fromSpecs);
    // Captured is a SUBSET of accepted, never the other way round: a run may
    // measure fewer engines than the schema accepts, but it must never capture
    // an engine whose cells would then fail validation on read.
    for (const engine of SEO_GEO_CAPTURE_ENGINES) {
      expect(SEO_GEO_VISIBILITY_ENGINES).toContain(engine);
    }
  });

  it("leaves the two adapter-less engines out of the capture fan-out", () => {
    // Accepted so a cell can be stored the moment an adapter exists; not
    // captured, because fanning out to an engine with no adapter writes a
    // column of UNAVAILABLE cells that measures nothing and drags down the
    // coverage percentage a client feels.
    expect(SEO_GEO_CAPTURE_ENGINES).not.toContain("aimode");
    expect(SEO_GEO_CAPTURE_ENGINES).not.toContain("google_aio");
    expect(SEO_GEO_VISIBILITY_ENGINE_SPECS.aimode.captured).toBe(false);
    expect(SEO_GEO_VISIBILITY_ENGINE_SPECS.google_aio.captured).toBe(false);
  });

  it("accepts every ratified engine on a persisted cell, and rejects one that is not ratified", () => {
    // `schemas.ts`'s `z.enum(SEO_GEO_VISIBILITY_ENGINES)` guards cells on READ,
    // so a widened list must not narrow what validates. Exercised through the
    // real schema, not by re-reading the constant it was built from.
    const cell = (engine: string) => ({
      visibility: {
        cells: [{ promptId: "p1", engine, captureTier: "UNAVAILABLE", brandMentioned: false, brandCited: false }],
        promptCount: 1,
        clientDomains: ["acme.example"],
      },
    });
    for (const engine of SEO_GEO_VISIBILITY_ENGINES) {
      expect(ScoreInputSchema.safeParse(cell(engine)).success, `engine ${engine} must validate`).toBe(true);
    }
    expect(ScoreInputSchema.safeParse(cell("bing_chat")).success).toBe(false);
  });

  it("keeps the v1.1 config port's engines[] a subset of the accepted list", () => {
    // `capture-config.data.ts` is a byte-for-fidelity transcription that is
    // deliberately NOT edited (see its HISTORY banner). It is five engines to
    // this list's seven, which is fine — what must never happen is the port
    // naming an engine the schema would reject on read.
    const portedKeys = captureConfigData.engines.map((engine) => engine.key);
    expect(portedKeys.length).toBeGreaterThan(0);
    for (const key of portedKeys) {
      expect(SEO_GEO_VISIBILITY_ENGINES as readonly string[], `v1.1 port names ${key}`).toContain(key);
    }
    // And the port's claude row is the costed first-party spec the adapter
    // implements — the evidence that "Claude cannot be measured here" was never
    // this repo's situation.
    expect(portedKeys).toContain("claude");
  });

  it("records the decision and its date in-repo, the way SCRUM-392 recorded karos_tool", () => {
    expect(SEO_GEO_VISIBILITY_ENGINE_DECISION.status).toBe("ratified");
    expect(SEO_GEO_VISIBILITY_ENGINE_DECISION.decidedOn).toBe("2026-09-02");
    expect(SEO_GEO_VISIBILITY_ENGINE_DECISION.ticket).toBe("SCRUM-396");
    expect(SEO_GEO_VISIBILITY_ENGINE_DECISION.added).toEqual(["aimode", "google_aio"]);
    // The decision's own copy of the lists is the constant, not a transcription.
    expect(SEO_GEO_VISIBILITY_ENGINE_DECISION.accepted).toBe(SEO_GEO_VISIBILITY_ENGINES);
    expect(SEO_GEO_VISIBILITY_ENGINE_DECISION.captured).toBe(SEO_GEO_CAPTURE_ENGINES);
    // A reader who opens the audit's §4c table instead must be sent elsewhere.
    expect(SEO_GEO_VISIBILITY_ENGINE_DECISION.notAuthority).toMatch(/HISTORY/);
  });

  it("freezes both lists so a caller cannot mutate the source of truth", () => {
    const accepted = SEO_GEO_VISIBILITY_ENGINES as readonly string[] as string[];
    const captured = SEO_GEO_CAPTURE_ENGINES as readonly SeoGeoVisibilityEngine[] as SeoGeoVisibilityEngine[];
    expect(() => accepted.push("bing_chat")).toThrow();
    expect(() => captured.pop()).toThrow();
  });
});
