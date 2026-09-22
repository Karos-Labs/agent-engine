#!/usr/bin/env node
/**
 * Fails when the PRODUCTION dependency tree carries a high or critical
 * advisory that has not been explicitly accepted.
 *
 * ## Why this exists rather than a bare `npm audit --audit-level=high`
 *
 * There was no dependency gate in this repository at all — a supply-chain
 * advisory could land and ship with nothing anywhere saying so. The obvious
 * one-liner has a failure mode that makes it worse than nothing, though: the
 * moment a single unfixable advisory appears, someone lowers the threshold to
 * `critical` (or deletes the step), and the gate silently stops covering the
 * nine other things it used to. A gate that can be turned off by a one-word
 * edit during a bad afternoon is not a gate.
 *
 * So the threshold stays at HIGH permanently, and each accepted advisory is a
 * DATED ENTRY with a stated reason. Accepting one is a reviewable diff;
 * forgetting to remove it is visible; and an advisory nobody has looked at
 * still fails the build.
 *
 * ## `--omit=dev` is the point, not a convenience
 *
 * What ships in the container is the production tree. A dev-only advisory in
 * a test runner is worth knowing and is not worth blocking a deploy, and
 * mixing the two is how a gate becomes noise people route around.
 */
import { execFileSync } from "node:child_process";

/**
 * Advisories accepted on purpose, with the reason and the date.
 *
 * Rules for adding one: it must state what stops it being exploitable HERE —
 * not that it is inconvenient to fix. `until` is a reminder, not an
 * expiry: this script does not fail on a stale entry, because a gate that
 * starts failing on a date nobody remembers setting gets deleted rather than
 * revisited.
 */
const ACCEPTED = [
  {
    advisory: "GHSA-7mvr-c777-76hp",
    package: "playwright",
    since: "2026-09-22",
    until: "the Instagram render suites have been recalibrated against the Chromium 1.63 ships",
    why:
      "Playwright downloads browsers without verifying the TLS certificate. The download happens at IMAGE BUILD time inside Cloud Build, never in a deployed service and never on a client machine, so the exposure is a build step on Google's network pulling from Microsoft's CDN. The fix is 1.53 -> 1.63, which changes the bundled Chromium — and this repo's Instagram interest-floor suites are calibrated on rendered pixels against CI's exact Chromium (see docs and the render-calibration tests). The bump is therefore a deliberate, separately-verified change rather than something to slip into a security patch.",
  },
];

const ACCEPTED_IDS = new Set(ACCEPTED.map((a) => a.advisory));

function runAudit() {
  try {
    // `npm audit` exits non-zero when it finds anything, so a throw is the
    // normal path and the payload is on stdout either way.
    return execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", shell: process.platform === "win32" });
  } catch (err) {
    const stdout = /** @type {{stdout?: string}} */ (err).stdout;
    if (typeof stdout === "string" && stdout.trim().startsWith("{")) return stdout;
    throw err;
  }
}

/** Every advisory id behind one vulnerability entry — `via` nests for transitive ones. */
function advisoryIdsFor(vuln, all, seen = new Set()) {
  const ids = [];
  for (const via of vuln.via ?? []) {
    if (typeof via === "object" && via !== null) {
      const url = String(via.url ?? "");
      const match = /GHSA-[a-z0-9-]+/i.exec(url);
      if (match) ids.push(match[0]);
    } else if (typeof via === "string" && !seen.has(via) && all[via]) {
      // A transitive entry names the package that carries the real advisory.
      seen.add(via);
      ids.push(...advisoryIdsFor(all[via], all, seen));
    }
  }
  return ids;
}

const report = JSON.parse(runAudit());
const vulns = report.vulnerabilities ?? {};
const blocking = [];
const accepted = [];

for (const [name, vuln] of Object.entries(vulns)) {
  if (vuln.severity !== "high" && vuln.severity !== "critical") continue;
  const ids = advisoryIdsFor(vuln, vulns);
  // Accepted only when EVERY advisory behind it is accepted. A package that
  // picks up a second, unreviewed advisory must start failing again.
  if (ids.length > 0 && ids.every((id) => ACCEPTED_IDS.has(id))) {
    accepted.push({ name, severity: vuln.severity, ids });
  } else {
    blocking.push({ name, severity: vuln.severity, ids, fix: vuln.fixAvailable });
  }
}

const counts = report.metadata?.vulnerabilities ?? {};
console.log(
  `  production tree: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low`,
);

for (const entry of accepted) {
  const note = ACCEPTED.find((a) => entry.ids.includes(a.advisory));
  console.log(`  - accepted  ${entry.severity} ${entry.name} (${entry.ids.join(", ")}) — since ${note?.since}`);
}

if (blocking.length === 0) {
  console.log("  ✓ no unaccepted high/critical advisories in the production dependency tree");
  process.exit(0);
}

console.error("");
for (const entry of blocking) {
  const fix = entry.fix === true ? "run `npm audit fix`" : entry.fix ? `upgrade to ${entry.fix.name}@${entry.fix.version}` : "no fix published yet";
  console.error(`  ✗ ${entry.severity.toUpperCase()} ${entry.name} ${entry.ids.join(", ")} — ${fix}`);
}
console.error(
  "\n  Fix it, or accept it deliberately by adding an entry to ACCEPTED in scripts/check-dependency-audit.mjs" +
    "\n  stating what stops it being exploitable in THIS codebase. Lowering the threshold is not an option the gate offers.",
);
process.exit(1);
