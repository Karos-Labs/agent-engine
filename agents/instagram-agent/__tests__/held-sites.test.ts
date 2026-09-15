import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE SOURCE GUARD: exactly three `throw new WorkflowHeld(` sites, and each one argued.
 *
 * RFC-19's whole content is that a run may not die of a QUALITY VERDICT. That is a statement about the
 * WORKFLOW'S SOURCE, not about any one run, and no behavioural test can make it: a fixture proves that one
 * gate delivers, and the next hold somebody adds is the one no fixture covers. So this test reads the source
 * — EVERY module under `src/workflow`, because the gates live in the siblings and a guard that reads one file
 * is a guard a hold can be added just outside of.
 *
 * A new `WorkflowHeld` fails CI with a message telling the author to argue it against RFC-19 §6 first. That
 * is the point — the bar for adding a hold to this agent is now an RFC entry, not a code review.
 *
 * ## Why these three, and no others
 *
 * 1. **No subject from any of three sources** (`03`). The owner's carve-out, first item: no catalog row, no
 *    requested subject, no declared industry. Three independent sources came up empty and fabricating one is
 *    what the 70-line comment around it exists to refuse. NOT the same hold as the brand-fit floor, which
 *    RFC-19 §4 item 16 converted: there the client HAS an industry and a floor refused the scouted stories,
 *    which is a quality event.
 * 2. **Research produced nothing readable** (`04b`). Shipping unsourced copy is worse than shipping nothing,
 *    and `zero-held-guarantee.test.ts` has said so since it was written.
 * 3. **No attempt produced schema-valid copy and no earlier attempt could be salvaged** (the narrowed
 *    terminus). The carve-out's "no output exists at all". Its old wording — *"step 07's self-check never
 *    passed after N attempt(s)"* — is asserted ABSENT below, because that sentence is what let nine
 *    unrelated causes hide behind one string.
 *
 * CRLF: this repository's files are CRLF, so every multi-line pattern here uses `\r?\n` (memory:
 * `python-text-writes-flip-to-crlf`, `agent-engine-worktree-and-crlf`).
 */

/**
 * EVERY module under `src/workflow`, not just the big one.
 *
 * The header above promises that "a new `throw new WorkflowHeld(` fails CI". Reading only
 * `create-instagram-agent-workflow.ts` did not keep that promise for any of the 20+ sibling modules the gates
 * actually live in — a hold added to `slides-data.ts`, `craft-hygiene.ts`, `value-gate.ts`, `language-gate.ts`
 * or either of the two modules this phase created would have passed every assertion below untouched. The
 * per-site assertions already search across sites, so concatenating costs nothing and closes the gap.
 *
 * Nothing is excluded. A hold is a hold wherever it is written.
 */
const WORKFLOW_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "workflow");

const WORKFLOW_FILES = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".ts"))
  .sort();

const source = WORKFLOW_FILES.map((f) => readFileSync(path.join(WORKFLOW_DIR, f), "utf8")).join("\n");

/** Every `throw new WorkflowHeld(` site with the text that follows it, up to the closing of the statement. */
function heldSites(text: string): string[] {
  const sites: string[] = [];
  const needle = "throw new WorkflowHeld(";
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) break;
    // The message is whatever follows, to the next `);` at the start of a line's content — enough to pin a
    // substring against without parsing TypeScript.
    sites.push(text.slice(at, at + 900));
    from = at + needle.length;
  }
  return sites;
}

describe("RFC-19: the workflow has exactly three WorkflowHeld sites, and each one is a real fault", () => {
  const sites = heldSites(source);

  it("throws WorkflowHeld in exactly three places", () => {
    expect(
      sites.length,
      "A new `throw new WorkflowHeld(` appeared in create-instagram-agent-workflow.ts. RFC-19 §6 lists the " +
        "three holds this agent is allowed to have, and every one of them is a REAL FAULT (no client config, " +
        "no readable research, no draft at all). A judge scoring below a bar, a self-check that never passed, " +
        "a floor that refused every attempt and a schema that came back malformed are QUALITY EVENTS: the run " +
        "must record a SelfCheckFinding and deliver degraded. Argue the new hold against RFC-19 §6 before " +
        "changing this number.",
    ).toBe(3);
  });

  it("keeps the no-subject hold (the owner's carve-out: nobody to write for)", () => {
    expect(sites.some((s) => /no subject available for this run/.test(s))).toBe(true);
  });

  it("keeps the no-readable-research hold (shipping unsourced copy is worse than shipping nothing)", () => {
    expect(sites.some((s) => /research/i.test(s) && /schema|readable source/i.test(s))).toBe(true);
  });

  it("keeps the narrowed terminus: no draft exists at all", () => {
    expect(sites.some((s) => /no drafting attempt produced copy that cleared its own schema/.test(s))).toBe(true);
    expect(sites.some((s) => /no earlier attempt could be salvaged/.test(s))).toBe(true);
  });

  it("DELETES the generic self-check-exhaustion wording outright", () => {
    // The sentence RFC-19 §4 item 1 removes by name. Nine unrelated causes reached it — a banned word, a
    // curly quote, a sub-floor relevance score, an off-kit hex, a silent judge, a dropped discriminator —
    // and every one of them read as the same thing to whoever got paged.
    expect(source).not.toMatch(/self-check never passed after/);
  });

  it("does not hold for a target language it could not resolve — that is blocked_intake, a config gap", () => {
    // RFC-19 §4 item 18: one word, and not a quality change at all. The run still stops; it stops filed as
    // the missing input it is, beside its five siblings.
    const intakeAt = source.indexOf("target language could not be resolved for this client");
    expect(intakeAt).toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, intakeAt - 200), intakeAt)).toMatch(/throw new WorkflowBlockedIntake\(\r?\n\s*`$/);
  });

  it("does not fail an APPROVED post over a ledger write", () => {
    // The bookkeeping cluster. `ledger.recordUsedImages` and `topics.commit` both run AFTER a human approved
    // the post (and, for the second, after `writeDeliverable` returned an id). Losing either costs a signal;
    // failing the post over it costs the post.
    expect(source).not.toMatch(/throw new WorkflowToolingFailure\(`ledger\.recordUsedImages failed/);
    expect(source).not.toMatch(/throw new WorkflowToolingFailure\(`topics\.commit failed/);
    expect(source).not.toMatch(/throw new WorkflowToolingFailure\(`ledger\.listUsedImages failed/);
  });

  it("does not throw on a copy, vetting or visual-QA step that resolved to tooling_error", () => {
    // RFC-19 §4 items 11, 13 and 15 — a REGISTERED agent step that could not produce a readable turn has
    // formed no opinion about the draft, and each of these merged into the quality branch one line below it.
    // (An UNREGISTERED tool is a different thing and still throws — that is a deploy defect, RFC-19 §6.8.)
    expect(source).not.toMatch(/throw new WorkflowToolingFailure\(`copy step resolved to/);
    expect(source).not.toMatch(/throw new WorkflowToolingFailure\(`image vetting step resolved to/);
    expect(source).not.toMatch(/throw new WorkflowToolingFailure\(`visual QA step resolved to/);
    // The fourth member of the family, and the one that survived the first pass of this list precisely
    // BECAUSE the list omitted it. `04b` threw on `tooling_error` and `budget_exceeded` — two of the four
    // `AgentExecutionStatus` members — twenty-two lines above a $0 fallback holding every fetched document.
    // Same cause as `05`'s: two dropped `type` discriminators (`base-agent.ts`, `maxMalformedTurns: 1`).
    expect(source).not.toMatch(/throw new WorkflowToolingFailure\(`research extraction step resolved to/);
  });

  it("guards every in-loop quality gate on isFinalAttempt rather than on nothing", () => {
    // Mechanism A's call sites, all reading ONE existing local. Counting them EXACTLY is what stops a future
    // edit silently dropping one back into a `continue` — the defect `isFinalAttempt`'s own doc comment
    // describes. A `>=` here let four be deleted before anything noticed, so this is pinned the way
    // `turns.ts`'s queues are: change the number only alongside the site you added or removed.
    //
    // 16 = 12 bare `if (!isFinalAttempt)` + 4 compound `if (!isFinalAttempt && …)` (the `07`
    // `compliance-unverified` exemption among them).
    //
    // Was 15. The site ADDED, named here as this pin's own protocol requires: `07h2-word-budget`,
    // the slide word budget (owner rule, 2026-09-15 — 20 to 30 words a slide, the detail to the
    // caption). It belongs in this family for the reason the family exists: over the limit it
    // `continue`s to a fresh draft, which is a real remedy while there are attempts left, and on
    // the final attempt there is no draft left to ask for so the finding goes to the judge instead.
    // A bare guard rather than a compound one, because unlike a judge outage a word count is never
    // an absence of a verdict: the words are on the plate and code has read them.
    //
    // Was 16. The site REMOVED, deliberately and named here as this pin's own protocol requires: `08b`'s
    // `qaExec.status !== "completed"` branch. That is a judge OUTAGE, not a verdict, and Mechanism C's rule
    // is that an outage never costs a drafting attempt — the exemption `07` already grants
    // `compliance-unverified` in its own compound guard above. Gating it on `isFinalAttempt` made attempts
    // 1..n-1 re-draft against a judge that had gone silent, re-paying for copy, sourcing, vetting, any
    // generative rescue and a full render each time. A judge that ANSWERED and refused is untouched and
    // still holds its bare guard one branch below.
    const guards = source.match(/if \(!isFinalAttempt[ )]/g) ?? [];
    expect(guards.length).toBe(16);
  });
});
