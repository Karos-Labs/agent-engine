import type { AgentToolOutcome, GateVerdict } from "@agent-engine/core";
import { success, toolingError } from "@agent-engine/tool-common";
import type { ProcessResult } from "./process/runner.js";

/**
 * Returns a gate's `GateVerdict` at the correct OUTCOME layer (AU8 / SCRUM-289,
 * RFC-01 §6).
 *
 * `toGateVerdictFromBullets`/`toGateVerdictFromPrefixedLines` can legitimately
 * produce `verdict: "tooling_error"` — a Python script that crashed without a
 * parseable report is not a content judgment. But every one of these tools used
 * to hand that straight to `success(...)`, producing
 * `{status: "success", result: {verdict: "tooling_error"}}`: a broken engine
 * script read as a SUCCESSFUL tool call at the `AgentToolOutcome` layer, which
 * inverts the four-outcome contract the whole tool layer depends on. Anything
 * inspecting `outcome.status` — the ReAct loop, telemetry's `outcome_status`
 * span attribute, any generic caller — saw success.
 *
 * Passing every verdict through here keeps the two layers agreeing: a content
 * verdict travels as `success`, a broken run travels as `tooling_error` with
 * the reason intact.
 */
export function gateOutcome(verdict: GateVerdict): AgentToolOutcome<GateVerdict> {
  if (verdict.verdict === "tooling_error") {
    return toolingError(verdict.reason ?? "gate reported a tooling error without a reason");
  }
  return success(verdict);
}

function nonEmptyLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** `- reason` lines under a `<LABEL> GATE: FAIL (n)` summary (`cut_check.py`, `cutaway_check.py`, `brand_assets_check.py`). */
function bulletLines(stdout: string): string[] {
  return nonEmptyLines(stdout)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

/**
 * `brand_assets_check.py`'s non-fatal advisories (`print(f"  WARN  {w}")`) —
 * e.g. "alpha channel is fully transparent — nothing will render." These are
 * exactly the class of silent-defect signal that script exists to catch
 * (the audit's own example), so they must survive into the `GateVerdict`'s
 * evidence on EVERY branch, pass or fail, never dropped on a bare PASS.
 */
function warnLines(stdout: string): string[] {
  return nonEmptyLines(stdout)
    .filter((line) => line.startsWith("WARN"))
    .map((line) => `WARNING: ${line.replace(/^WARN\s*/, "").trim()}`);
}

/**
 * Maps a completed run of `cut_check.py` / `cutaway_check.py` /
 * `brand_assets_check.py` onto a `GateVerdict` (RFC-01 §6). Exit 0 is always
 * a pass; a non-zero exit WITH parseable `- reason` bullets is a real
 * `content_fail`; a non-zero exit with nothing parseable (a traceback, a
 * missing dependency) is a `tooling_error` — a broken script run is never
 * reinterpreted as content signal. `WARN` lines (only `brand_assets_check.py`
 * emits them today) are appended to evidence regardless of which branch fires.
 */
export function toGateVerdictFromBullets(result: ProcessResult, scriptName: string, toolVersion: string): GateVerdict {
  const evidence = bulletLines(result.stdout);
  const warnings = warnLines(result.stdout);
  if (result.exitCode === 0) {
    const summary = nonEmptyLines(result.stdout).find((line) => /GATE:\s*PASS|ASSETS:\s*PASS/i.test(line));
    const base = summary ? [summary] : [`${scriptName}: PASS`];
    return { verdict: "pass", evidence: [...base, ...warnings], toolVersion };
  }
  if (evidence.length > 0) {
    return { verdict: "content_fail", evidence: [...evidence, ...warnings], reason: evidence.join("; "), toolVersion };
  }
  const tail = (result.stderr || result.stdout || "").trim().slice(-2000);
  return {
    verdict: "tooling_error",
    reason: `${scriptName} exited ${result.exitCode} without a parseable report${tail ? `: ${tail}` : ""}`,
    toolVersion,
  };
}

/** `FAIL ...` / `PASS ...` per-item lines with no aggregate summary (`brand_check.py`, `graphic_qa.py`). */
export function toGateVerdictFromPrefixedLines(result: ProcessResult, scriptName: string, toolVersion: string): GateVerdict {
  const lines = nonEmptyLines(result.stdout);
  const failLines = lines.filter((line) => line.startsWith("FAIL"));
  const passLines = lines.filter((line) => line.startsWith("PASS"));

  if (result.exitCode === 0 && failLines.length === 0) {
    return { verdict: "pass", evidence: passLines.length > 0 ? passLines : [`${scriptName}: PASS (nothing to check)`], toolVersion };
  }
  if (failLines.length > 0) {
    return { verdict: "content_fail", evidence: failLines, reason: failLines.join("; "), toolVersion };
  }
  const tail = (result.stderr || result.stdout || "").trim().slice(-2000);
  return {
    verdict: "tooling_error",
    reason: `${scriptName} exited ${result.exitCode} without a parseable PASS/FAIL report${tail ? `: ${tail}` : ""}`,
    toolVersion,
  };
}
