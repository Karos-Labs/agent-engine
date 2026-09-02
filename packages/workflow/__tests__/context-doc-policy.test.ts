import { describe, expect, it } from "vitest";
import { WorkflowBlockedIntake } from "../src/primitives/signals.js";
import { CONTEXT_DOC_POLICY, enforceContextDocPolicy } from "../src/primitives/context-doc-policy.js";

/**
 * SCRUM-242 (T-A10). Unit coverage for the shared policy table + helper in
 * isolation, independent of any one agent's workflow. The required
 * cross-agent fixture (all four grounded agents, one context-doc-absent
 * run, asserting the two BLOCKs and the two visible DEGRADED markers) lives
 * in `context-doc-policy-fixture.test.ts` — this file is the narrower unit
 * layer underneath it: proving `enforceContextDocPolicy` itself gets each
 * individual case right (ok / degraded / block / an unrecognized agent id),
 * and pinning the proposed table's shape so a silent edit to a row shows up
 * as a diff here.
 */
describe("CONTEXT_DOC_POLICY (SCRUM-242/T-A10) — the one shared table", () => {
  it("has exactly the five rows T-A9's own ticket named, with the proposed decisions", () => {
    // Pinned exactly as this ticket's report states them: a PROPOSAL, not
    // settled fact — see this module's own doc comment and the report.
    expect(CONTEXT_DOC_POLICY["intel-report-agent"]?.decision).toBe("block");
    expect(CONTEXT_DOC_POLICY["landing-builder-agent"]?.decision).toBe("block");
    expect(CONTEXT_DOC_POLICY["instagram-agent"]?.decision).toBe("degraded");
    expect(CONTEXT_DOC_POLICY["branded-shorts-agent"]?.decision).toBe("degraded");
    // Present, but SCRUM-242 does not wire it to any call site — Batch 2 owns
    // agents/seo-geo-agent/src/workflow/create-seo-geo-agent-workflow.ts.
    expect(CONTEXT_DOC_POLICY["seo-geo-agent"]).toBeDefined();
    expect(Object.keys(CONTEXT_DOC_POLICY).sort()).toEqual(
      ["branded-shorts-agent", "instagram-agent", "intel-report-agent", "landing-builder-agent", "seo-geo-agent"].sort(),
    );
  });

  it("every row carries a non-empty rationale — a decision with no stated reason is exactly what this table exists to replace", () => {
    for (const [agentId, row] of Object.entries(CONTEXT_DOC_POLICY)) {
      expect(row.rationale.trim().length, `${agentId}'s rationale`).toBeGreaterThan(0);
    }
  });
});

describe("enforceContextDocPolicy (SCRUM-242/T-A10)", () => {
  it("resolves 'ok' when every doc the agent reads is present", () => {
    const outcome = enforceContextDocPolicy({
      agentId: "instagram-agent",
      docs: { "branding-guidelines": "Never show identifiable faces." },
    });
    expect(outcome).toEqual({ decision: "ok" });
  });

  it("resolves 'ok' on PARTIAL grounding — at least one of the agent's docs present — even for a BLOCK-row agent", () => {
    // intel-report-agent reads two doc types; only one being present is real
    // signal reaching the prompt, not the "looks grounded but isn't" failure
    // this ticket targets. See the module's own doc comment for why "missing
    // required context" means ALL of an agent's docs, not "at least one."
    const outcome = enforceContextDocPolicy({
      agentId: "intel-report-agent",
      docs: { "target-audience": "Price-sensitive SMBs.", "market-strategy": undefined },
    });
    expect(outcome).toEqual({ decision: "ok" });
  });

  it("a DEGRADED row (instagram-agent) returns a visible marker, never throws, when every doc is absent", () => {
    const outcome = enforceContextDocPolicy({ agentId: "instagram-agent", docs: { "branding-guidelines": undefined } });
    expect(outcome.decision).toBe("degraded");
    if (outcome.decision !== "degraded") throw new Error("unreachable");
    expect(outcome.marker).toEqual({
      contextGroundingStatus: "degraded",
      agentId: "instagram-agent",
      missingDocTypes: ["branding-guidelines"],
      reason: expect.stringContaining("instagram-agent: missing required context doc(s) [branding-guidelines]"),
    });
  });

  it("a BLOCK row (intel-report-agent) throws WorkflowBlockedIntake, with a stated reason naming every missing doc type, when every doc is absent", () => {
    expect(() =>
      enforceContextDocPolicy({ agentId: "intel-report-agent", docs: { "target-audience": undefined, "market-strategy": undefined } }),
    ).toThrow(WorkflowBlockedIntake);

    try {
      enforceContextDocPolicy({ agentId: "intel-report-agent", docs: { "target-audience": undefined, "market-strategy": undefined } });
      throw new Error("unreachable — enforceContextDocPolicy should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowBlockedIntake);
      expect((err as Error).message).toContain("intel-report-agent: missing required context doc(s) [target-audience, market-strategy]");
      expect((err as Error).message).toContain("client-facing deliverable");
    }
  });

  it("throws a plain (non-WorkflowBlockedIntake) Error for an agent id with no policy row — a fifth agent must get a decision, never a silent default", () => {
    expect(() => enforceContextDocPolicy({ agentId: "some-future-agent", docs: { "brand-voice": undefined } })).toThrow(
      /no CONTEXT_DOC_POLICY row for agent "some-future-agent"/,
    );
    try {
      enforceContextDocPolicy({ agentId: "some-future-agent", docs: { "brand-voice": undefined } });
    } catch (err) {
      expect(err).not.toBeInstanceOf(WorkflowBlockedIntake);
    }
  });
});

/**
 * SCRUM-388 — the bootstrap deadlock, and `bootstrapExempt`.
 *
 * intel-report-agent's row is the one row this ticket flips to
 * `bootstrapExempt: true` (see this module's own doc comment for the full
 * account: onboarding dispatches this exact agent to PRODUCE the very docs
 * its BLOCK row checks for). Every case below is against that same row —
 * `runKind` is the ONLY thing that changes between them.
 */
describe("enforceContextDocPolicy — SCRUM-388 bootstrap exemption (bootstrapExempt)", () => {
  it("a bootstrapExempt BLOCK row (intel-report-agent) degrades — with a visible marker, not a throw — on a runKind: 'setup' run when every doc is absent", () => {
    const outcome = enforceContextDocPolicy({
      agentId: "intel-report-agent",
      docs: { "target-audience": undefined, "market-strategy": undefined },
      runKind: "setup",
    });
    expect(outcome.decision).toBe("degraded");
    if (outcome.decision !== "degraded") throw new Error("unreachable");
    expect(outcome.marker).toEqual({
      contextGroundingStatus: "degraded",
      agentId: "intel-report-agent",
      missingDocTypes: ["target-audience", "market-strategy"],
      reason: expect.stringContaining("intel-report-agent: missing required context doc(s) [target-audience, market-strategy]"),
    });
    // The marker's own reason names the exemption explicitly — this is not
    // indistinguishable from an ordinary DEGRADED row's marker.
    expect(outcome.marker.reason).toContain('exempted from BLOCK because this is a runKind:"setup" run');
  });

  it("the same bootstrapExempt row still throws WorkflowBlockedIntake on a runKind: 'recurring' run — the exemption is scoped to bootstrap only", () => {
    expect(() =>
      enforceContextDocPolicy({
        agentId: "intel-report-agent",
        docs: { "target-audience": undefined, "market-strategy": undefined },
        runKind: "recurring",
      }),
    ).toThrow(WorkflowBlockedIntake);
  });

  it("the same bootstrapExempt row still throws WorkflowBlockedIntake when runKind is omitted entirely — a caller that never passes wf.runKind gets the pre-SCRUM-388 behavior unchanged", () => {
    expect(() =>
      enforceContextDocPolicy({
        agentId: "intel-report-agent",
        docs: { "target-audience": undefined, "market-strategy": undefined },
      }),
    ).toThrow(WorkflowBlockedIntake);
  });

  it("a non-bootstrapExempt BLOCK row (landing-builder-agent) still throws on runKind: 'setup' — the exemption is per-row, not global to every BLOCK row on a setup run", () => {
    expect(CONTEXT_DOC_POLICY["landing-builder-agent"]?.bootstrapExempt).toBeUndefined();
    expect(() =>
      enforceContextDocPolicy({
        agentId: "landing-builder-agent",
        docs: { "product-information": undefined },
        runKind: "setup",
      }),
    ).toThrow(WorkflowBlockedIntake);
  });

  it("runKind has no effect on an already-DEGRADED row (instagram-agent) — 'setup' produces the same marker a recurring run would", () => {
    const outcome = enforceContextDocPolicy({
      agentId: "instagram-agent",
      docs: { "branding-guidelines": undefined },
      runKind: "setup",
    });
    expect(outcome.decision).toBe("degraded");
    if (outcome.decision !== "degraded") throw new Error("unreachable");
    // Not the bootstrap-exemption phrasing — this row was never a BLOCK to
    // begin with, so nothing was exempted.
    expect(outcome.marker.reason).not.toContain("exempted from BLOCK");
  });
});
