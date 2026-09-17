import { describe, expect, it, vi } from "vitest";
import type { GateVerdict } from "@agent-engine/core";
import {
  localContentFail,
  localPass,
  redactSentencesCarrying,
  spansFromEvidence,
  stripSpansFrom,
  runCheckWithRepair,
  hasUnresolvedRepair,
  WorkflowToolingFailure,
} from "../src/index.js";

/** A `content_fail` with the given evidence, shaped like a real gate's. */
function fail(evidence: string[], reason = "nope"): GateVerdict {
  return { verdict: "content_fail", evidence, reason, toolVersion: "test/1.0.0" };
}
function pass(): GateVerdict {
  return { verdict: "pass", evidence: [], toolVersion: "test/1.0.0" };
}

describe("redactSentencesCarrying", () => {
  it("drops the sentence carrying the span and keeps its neighbours", () => {
    const out = redactSentencesCarrying(
      "The signup flow is three steps. Conversion improved 43% after the redesign. Pricing is public.",
      ["43%"],
    );

    expect(out.text).toBe("The signup flow is three steps. Pricing is public.");
    expect(out.droppedSentences).toBe(1);
    expect(out.redactedSpans).toEqual(["43%"]);
  });

  it("returns the ORIGINAL string byte-for-byte when nothing matched", () => {
    // Re-joining unconditionally would flatten paragraph breaks into single
    // spaces and silently rewrite prose the call was not asked to touch.
    const original = "First paragraph.\n\nSecond paragraph.";

    const out = redactSentencesCarrying(original, ["99%"]);

    expect(out.text).toBe(original);
    expect(out.droppedSentences).toBe(0);
  });

  it("falls back to the given text when every sentence carried a span", () => {
    const out = redactSentencesCarrying("Pipeline is up 40%.", ["40%"], "Withheld.");

    expect(out.text).toBe("Withheld.");
  });

  it("empties to '' by default rather than inventing a placeholder", () => {
    const out = redactSentencesCarrying("Pipeline is up 40%.", ["40%"]);

    expect(out.text).toBe("");
  });

  it("handles the four gates' evidence shapes with one pass", () => {
    // numbers, placeholder, leak and brand-term evidence are all "the
    // offending literal as it appears in the draft".
    const text = "We grew 43%. Insert [TODO] here. The key is sk-live-abc123. We are simply the best.";

    const out = redactSentencesCarrying(text, ["43%", "[TODO]", "sk-live-abc123", "the best"]);

    expect(out.text).toBe("");
    expect(out.droppedSentences).toBe(4);
  });

  it("is a no-op on an empty span list", () => {
    const original = "Nothing to do here.";
    expect(redactSentencesCarrying(original, []).text).toBe(original);
  });
});

describe("spansFromEvidence", () => {
  it("passes a bare literal through untouched", () => {
    // numbersSourced / noPlaceholder / brandCompliance shape.
    expect(spansFromEvidence(["43%", "[TODO]", "guaranteed"])).toEqual(["43%", "[TODO]", "guaranteed"]);
  });

  it("unwraps gate.leakCheck's labelled, quoted shape", () => {
    // Without this the leak floor matches nothing, drops nothing, and reports
    // every span unresolved — a floor that looks like it ran and did not.
    expect(spansFromEvidence(['local file path: "/Users/jane/notes.md"'])).toEqual(["/Users/jane/notes.md"]);
    expect(spansFromEvidence(['internal term: "staging-only"'])).toEqual(["staging-only"]);
  });

  it("handles a mixed batch from several gates at once", () => {
    expect(spansFromEvidence(["43%", 'api key: "sk-live-abc123"'])).toEqual(["43%", "sk-live-abc123"]);
  });

  it("does not mangle a literal that merely contains a colon", () => {
    expect(spansFromEvidence(["https://example.com/a"])).toEqual(["https://example.com/a"]);
  });

  it("de-duplicates and drops empties", () => {
    expect(spansFromEvidence(["43%", "43%", "  "])).toEqual(["43%"]);
  });
});

describe("stripSpansFrom", () => {
  it("excises the span from a title and tidies the seam", () => {
    const out = stripSpansFrom("The best CRM for busy teams", ["The best"]);

    expect(out.text).toBe("CRM for busy teams");
    expect(out.strippedSpans).toEqual(["The best"]);
    expect(out.emptied).toBe(false);
  });

  it("does not leave a double space or a dangling comma behind", () => {
    const out = stripSpansFrom("Fast, guaranteed, and cheap", ["guaranteed"]);

    expect(out.text).toBe("Fast, and cheap");
  });

  it("leaves a field it would empty UNCHANGED and says so", () => {
    // Callers' schemas are `min(1)`; handing back "" would fail validation and
    // lose the deliverable this whole mechanism exists to protect.
    const out = stripSpansFrom("guaranteed", ["guaranteed"]);

    expect(out.text).toBe("guaranteed");
    expect(out.emptied).toBe(true);
    expect(out.strippedSpans).toEqual(["guaranteed"]);
  });

  it("is a no-op when no span is present", () => {
    const original = "A perfectly ordinary title";
    const out = stripSpansFrom(original, ["nope"]);

    expect(out.text).toBe(original);
    expect(out.strippedSpans).toEqual([]);
  });

  it("removes every occurrence of a repeated span", () => {
    const out = stripSpansFrom("guaranteed results, guaranteed savings", ["guaranteed"]);

    expect(out.text).toBe("results, savings");
  });
});

describe("runCheckWithRepair", () => {
  it("does not run a single attempt when the check passes", async () => {
    const attempt = vi.fn();

    const out = await runCheckWithRepair({
      check: "gate.test",
      value: "clean",
      verify: async () => pass(),
      attempts: [{ action: "rewritten", run: attempt }],
    });

    expect(out.value).toBe("clean");
    expect(out.repairs).toEqual([]);
    expect(attempt).not.toHaveBeenCalled();
  });

  it("keeps a repair that fixes the problem and records it", async () => {
    const out = await runCheckWithRepair({
      check: "gate.numbersSourced",
      value: "grew 43%",
      verify: async (v) => (v.includes("43%") ? fail(["43%"]) : pass()),
      attempts: [{ action: "rewritten", run: () => "grew substantially" }],
    });

    expect(out.value).toBe("grew substantially");
    expect(out.verdict.verdict).toBe("pass");
    expect(out.repairs).toEqual([
      { check: "gate.numbersSourced", action: "rewritten", detail: "43% — rewritten to satisfy gate.numbersSourced" },
    ]);
  });

  it("DISCARDS a repair that is not strictly better", async () => {
    // The load-bearing property: attempting a repair must never be able to
    // make the content worse than what it was handed.
    const out = await runCheckWithRepair({
      check: "gate.test",
      value: "one bad 43%",
      verify: async (v) => {
        if (v === "one bad 43%") return fail(["43%"]);
        return fail(["61%", "77%"]); // the "repair" invented two new problems
      },
      attempts: [{ action: "rewritten", run: () => "two bad 61% 77%" }],
    });

    expect(out.value).toBe("one bad 43%");
    expect(out.repairs).toEqual([
      { check: "gate.test", action: "unresolved", detail: "could not be resolved: nope" },
    ]);
  });

  it("discards a repair that merely trades one violation for another", async () => {
    const out = await runCheckWithRepair({
      check: "gate.test",
      value: "bad 43%",
      verify: async (v) => (v === "bad 43%" ? fail(["43%"]) : fail(["61%"])),
      attempts: [{ action: "rewritten", run: () => "bad 61%" }],
    });

    expect(out.value).toBe("bad 43%");
  });

  it("falls through to the next attempt when the first cannot apply", async () => {
    const out = await runCheckWithRepair({
      check: "gate.test",
      value: "grew 43%",
      verify: async (v) => (v.includes("43%") ? fail(["43%"]) : pass()),
      attempts: [
        { action: "rewritten", run: () => undefined }, // model unavailable
        { action: "redacted", run: (v) => redactSentencesCarrying(v, ["43%"]).text },
      ],
    });

    expect(out.value).toBe("");
    expect(out.repairs.map((r) => r.action)).toEqual(["redacted"]);
  });

  it("tries attempts in order, so a model rewrite wins over a deletion", async () => {
    const redact = vi.fn();

    const out = await runCheckWithRepair({
      check: "gate.test",
      value: "grew 43%",
      verify: async (v) => (v.includes("43%") ? fail(["43%"]) : pass()),
      attempts: [
        { action: "rewritten", run: () => "grew a lot" },
        { action: "redacted", run: redact },
      ],
    });

    expect(out.value).toBe("grew a lot");
    expect(redact).not.toHaveBeenCalled();
  });

  it("loops a multi-pass attempt while it keeps making progress, then stops", async () => {
    // Each pass removes exactly one problem; three problems, maxPasses 5.
    let remaining = ["a", "b", "c"];

    const out = await runCheckWithRepair({
      check: "gate.test",
      value: "start",
      verify: async () => (remaining.length > 0 ? fail([...remaining]) : pass()),
      attempts: [
        {
          action: "redacted",
          maxPasses: 5,
          run: (v) => {
            remaining = remaining.slice(1);
            return `${v}+`;
          },
        },
      ],
    });

    expect(out.verdict.verdict).toBe("pass");
    expect(out.value).toBe("start+++");
    expect(out.repairs).toHaveLength(3);
  });

  it("stops a multi-pass attempt that stops making progress", async () => {
    // Termination: an attempt that returns something no better must not spin
    // to its pass ceiling. One try, one rejection, done.
    const run = vi.fn(() => "no better");

    const out = await runCheckWithRepair({
      check: "gate.test",
      value: "bad",
      verify: async () => fail(["x"]),
      attempts: [{ action: "redacted", maxPasses: 99, run }],
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(out.repairs.map((r) => r.action)).toEqual(["unresolved"]);
  });

  it("DELIVERS with an unresolved note rather than throwing when everything fails", async () => {
    // This is the branch that used to be `throw new WorkflowHeld(...)`.
    const out = await runCheckWithRepair({
      check: "gate.leakCheck",
      value: "unfixable",
      verify: async () => fail(["sk-live-abc"], "credential found"),
      attempts: [{ action: "redacted", run: () => undefined }],
      describeUnresolved: (v) => `still flagged: ${v.evidence.join(", ")}`,
    });

    expect(out.value).toBe("unfixable");
    expect(out.verdict.verdict).toBe("content_fail");
    expect(out.repairs).toEqual([
      { check: "gate.leakCheck", action: "unresolved", detail: "still flagged: sk-live-abc" },
    ]);
    expect(hasUnresolvedRepair({ repairs: out.repairs })).toBe(true);
  });

  it("STILL throws on tooling_error — a check that could not run judged nothing", async () => {
    // The one thing that must not become a repair. Treating a broken gate as
    // a pass would ship exactly what the gate exists to catch.
    await expect(
      runCheckWithRepair({
        check: "gate.test",
        value: "x",
        verify: async () => ({ verdict: "tooling_error", reason: "gate exploded", toolVersion: "test/1.0.0" }),
        attempts: [],
      }),
    ).rejects.toThrow(WorkflowToolingFailure);
  });

  it("throws on a tooling_error that appears only AFTER a repair", async () => {
    let first = true;

    await expect(
      runCheckWithRepair({
        check: "gate.test",
        value: "x",
        verify: async () => {
          if (first) {
            first = false;
            return fail(["a"]);
          }
          return { verdict: "tooling_error", reason: "gate exploded", toolVersion: "test/1.0.0" };
        },
        attempts: [{ action: "redacted", run: () => "y" }],
      }),
    ).rejects.toThrow(WorkflowToolingFailure);
  });

  it("re-verifies every candidate, so a repair cannot wave content through", async () => {
    const verify = vi.fn(async (v: string) => (v === "fixed" ? pass() : fail(["bad"])));

    await runCheckWithRepair({
      check: "gate.test",
      value: "start",
      verify,
      attempts: [{ action: "rewritten", run: () => "fixed" }],
    });

    expect(verify).toHaveBeenCalledWith("start");
    expect(verify).toHaveBeenCalledWith("fixed");
  });
});

describe("local rule verdicts", () => {
  it("names the workflow rule as the source rather than a tool", () => {
    const verdict = localContentFail("character-limit", "3012 chars, limit is 3000", ["3012"]);

    expect(verdict.verdict).toBe("content_fail");
    if (verdict.verdict !== "content_fail") throw new Error("unreachable");
    expect(verdict.toolVersion).toBe("workflow-rule/character-limit");
    expect(verdict.evidence).toEqual(["3012"]);
  });

  it("passes the same way", () => {
    expect(localPass("character-limit").verdict).toBe("pass");
  });

  it("drives runCheckWithRepair exactly like a real gate", async () => {
    const LIMIT = 20;

    const out = await runCheckWithRepair({
      check: "character-limit",
      value: "this post is far too long to publish",
      verify: async (v) =>
        v.length <= LIMIT ? localPass("character-limit") : localContentFail("character-limit", `${v.length} chars`, [`${v.length}`]),
      attempts: [{ action: "trimmed", run: (v) => v.slice(0, LIMIT) }],
    });

    expect(out.value).toHaveLength(LIMIT);
    expect(out.repairs.map((r) => r.action)).toEqual(["trimmed"]);
  });
});

describe("hasUnresolvedRepair", () => {
  it("is false for a clean or absent ledger", () => {
    expect(hasUnresolvedRepair(null)).toBe(false);
    expect(hasUnresolvedRepair({ repairs: [] })).toBe(false);
    expect(hasUnresolvedRepair({ repairs: [{ check: "g", action: "redacted", detail: "d" }] })).toBe(false);
  });
});
