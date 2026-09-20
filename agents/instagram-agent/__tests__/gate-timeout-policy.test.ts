import { describe, expect, it } from "vitest";
import {
  CLEAN_GATE_TIMEOUT,
  FLAGGED_GATE_TIMEOUT,
  gateTimeoutFor,
  type GateVerdict,
} from "../src/workflow/gate-verdict.js";

/**
 * ── A GATE THAT APPROVES ON TIMEOUT IS A DELAY, NOT A GATE (RFC-22 §3.4). ──
 *
 * The recorded incident is the TikTok audit of 2026-09-09: **two posts
 * approved by timeout at QA 3/10**. Nobody overruled the gate; nobody was ever
 * asked. Every Instagram post except a regulated-compliance one shipped on
 * `1h`/`auto_approve`.
 *
 * This file asserts both halves, because only asserting the first is how a
 * policy like this quietly becomes a rubber stamp again:
 *
 *   * a CLEAN post is untouched — an hour, then it ships, exactly as before;
 *   * every shape `verdictLine` already prints a complaint about now WAITS,
 *     and holds rather than publishing when nobody came.
 */

function verdictWith(over: Partial<GateVerdict> = {}): GateVerdict {
  return {
    summary: "",
    spend: { meteredUsd: 0.9, billedUsd: 0.9, estimatedShareUsd: 0, targetUsd: 1, maxUsd: 1.6, adaptations: [] },
    draftProvenance: { shippedAttempt: 1, attempts: [] },
    stepFailures: [],
    visualQa: { pass: true, findings: [] },
    packaging: { status: "ok", hashtags: 8, altTexts: 6, firstComment: true },
    imagery: { wanted: 4, shipped: 4, generated: 0, shortfall: [], provenance: [] },
    degradeMarkers: [],
    brandAsset: { present: true },
    ...over,
  } as GateVerdict;
}

const clean = { regulatedComplianceFinding: false };

describe("gateTimeoutFor: which posts are allowed to ship while nobody is looking", () => {
  it("lets a clean post auto-approve after an hour, exactly as every run before RFC-22", () => {
    const policy = gateTimeoutFor(verdictWith(), clean);
    expect(policy).toMatchObject({ duration: CLEAN_GATE_TIMEOUT, onTimeout: "auto_approve", flags: [] });
    // The reviewer is told this too. A policy with no stated reason is how the
    // old one survived as long as it did.
    expect(policy.reason).toContain("nothing is flagged");
  });

  it("holds a post the judge FAILED — the 2026-09-09 case, which is the whole point", () => {
    const policy = gateTimeoutFor(
      verdictWith({ visualQa: { pass: false, findings: [{ rule: "contrast", passed: false, note: "" } as never, { rule: "crop", passed: true, note: "" } as never] } }),
      clean,
    );
    expect(policy.duration).toBe(FLAGGED_GATE_TIMEOUT);
    expect(policy.onTimeout).toBe("hold");
    expect(policy.flags).toEqual(["visual QA failed 1 rule"]);
  });

  it("holds a post NOTHING judged, which is not the same as a post that passed", () => {
    // `pass: undefined` is the judge never running. Reading it as a pass is
    // the guard-that-cannot-fail shape this repo keeps finding.
    const policy = gateTimeoutFor(verdictWith({ visualQa: { findings: [] } }), clean);
    expect(policy.onTimeout).toBe("hold");
    expect(policy.flags[0]).toContain("never ran");
  });

  it("holds a post the judge called not publishable, even when every rule passed", () => {
    const policy = gateTimeoutFor(verdictWith({ visualQa: { pass: true, publishable: false, findings: [] } }), clean);
    expect(policy.onTimeout).toBe("hold");
    expect(policy.flags).toContain("the judge called this post not publishable");
  });

  it("holds a post with a DEGRADED slide, and names the slide", () => {
    const policy = gateTimeoutFor(
      verdictWith({ degradeMarkers: [{ slide: 3, from: "interior plate that asked for a photograph", to: "bare type plate", reason: "waived" }] }),
      clean,
    );
    expect(policy.onTimeout).toBe("hold");
    expect(policy.flags[0]).toBe("slide 3 degraded to bare type");
  });

  it("holds a post short of the pictures it asked for", () => {
    const policy = gateTimeoutFor(verdictWith({ imagery: { wanted: 4, shipped: 2, generated: 0, shortfall: [], provenance: [] } }), clean);
    expect(policy.onTimeout).toBe("hold");
    expect(policy.flags).toContain("2 of 4 wanted pictures shipped");
  });

  it("does NOT hold a post for a missing logo, because no reviewer decision can fix one", () => {
    // This limb shipped for one revision and `brand-compliance-gate` caught
    // it. `brandAsset.present` is false when the CLIENT'S BRAND KIT has no
    // `logoUrl` -- a configuration fact, not a fact about this post -- so
    // holding on it would park every post that client ever runs, and nothing
    // the reviewer could decide about the carousel in front of them would
    // clear it. It stays in `verdictLine` as `NO LOGO`, where a human reads it
    // and goes and fixes the brand record.
    //
    // The rule to apply to the next limb added here: a hold must name
    // something a reviewer can act on about THIS post.
    const policy = gateTimeoutFor(verdictWith({ brandAsset: { present: false } }), clean);
    expect(policy.onTimeout).toBe("auto_approve");
    expect(policy.flags).toEqual([]);
  });

  it("holds a post with failed packaging or a failed step", () => {
    for (const over of [
      { packaging: { status: "failed" as const, hashtags: 0, altTexts: 0, firstComment: false } },
      { stepFailures: [{ step: "08c-package-post", status: "budget_exceeded" as never, why: "", usdBurned: 0 }] },
    ]) {
      expect(gateTimeoutFor(verdictWith(over), clean).onTimeout).toBe("hold");
    }
  });

  it("names EVERY mark, not the first one it found", () => {
    // A reviewer who fixes the one thing the policy mentioned and finds the
    // post still waiting has been told a half-truth.
    const policy = gateTimeoutFor(
      verdictWith({
        visualQa: { pass: false, findings: [] },
        packaging: { status: "failed", hashtags: 0, altTexts: 0, firstComment: false },
        degradeMarkers: [{ slide: 2, from: "a", to: "b", reason: "c" }],
      }),
      clean,
    );
    expect(policy.flags).toHaveLength(3);
    for (const flag of policy.flags) expect(policy.reason).toContain(flag);
  });

  it("does NOT hold a post merely for costing more than the target", () => {
    // Money is the owner's business and an expensive post is not a worse one.
    // `budgets-adapt-never-hold` and the quality-before-cost ruling both point
    // the other way, and making an over-budget post wait would quietly turn
    // the budget into a quality gate.
    const policy = gateTimeoutFor(
      verdictWith({ spend: { meteredUsd: 2.4, billedUsd: 2.4, estimatedShareUsd: 0, targetUsd: 1, maxUsd: 1.6, adaptations: [], floorsHeld: [], skipped: [] } }),
      clean,
    );
    expect(policy.onTimeout).toBe("auto_approve");
  });

  it("keeps the regulated-compliance case exactly where RFC-19 §5.5 put it", () => {
    const policy = gateTimeoutFor(verdictWith(), { regulatedComplianceFinding: true });
    expect(policy).toMatchObject({ duration: "24h", onTimeout: "hold" });
    expect(policy.flags).toEqual(["regulated-compliance finding"]);
  });

  it("puts the compliance finding FIRST, so a flagged regulated post still reads as a compliance hold", () => {
    const policy = gateTimeoutFor(verdictWith({ packaging: { status: "failed", hashtags: 0, altTexts: 0, firstComment: false } }), { regulatedComplianceFinding: true });
    expect(policy.reason).toContain("regulated-compliance");
  });
});
