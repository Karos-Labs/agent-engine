import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HOLD_MANIFEST, type HoldSite } from "../src/hold-manifest.js";

/**
 * THE ENFORCER FOR "AN AGENT NEVER ENDS A RUN WITH NO DELIVERABLE".
 *
 * The owner's ruling of 2026-09-17, stated in a dozen doc comments across this
 * repo and checked by nothing — which is how, seven days later, four gates
 * were still answering a human's "no" by throwing away a finished landing
 * page, a measured SEO report, a drafted reputation pulse and a five-channel
 * campaign bundle. Prose is not an enforcer; this file is.
 *
 * Every `throw new WorkflowHeld(...)` in every agent workflow has to be in
 * `HOLD_MANIFEST` with a sentence saying why nothing exists to deliver there.
 * Adding a hold is then a deliberate act with a reviewable justification
 * rather than a line somebody typed at the end of a long function.
 *
 * ── WHY IT LIVES IN THIS PACKAGE ──
 *
 * `apps/agent-server` is the one workspace whose suite already asserts on
 * repo-wide files (`workspace-store-wiring`, `dist-freshness-guard`,
 * `guardrail-coverage`), and this is the same category: a rule about every
 * agent at once, which no single agent's suite can hold.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENTS_DIR = path.join(REPO_ROOT, "agents");

/**
 * Source with comments removed.
 *
 * Load-bearing rather than tidy: several of these files describe the holds
 * they no longer have — *"this used to `throw new WorkflowHeld(...)`, which
 * ended a run that had already paid for…"* — and a scan that counted those
 * would demand a manifest entry for a hold that is not there, which is the
 * exact inverse of the thing being checked. Strings are preserved so a
 * message's own text is still matchable.
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === c) break;
        j += 1;
      }
      out.push(source.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

/** Every workflow source under `agents/`, keyed by the agent directory name. */
function workflowSources(): Array<{ agent: string; file: string; code: string }> {
  const found: Array<{ agent: string; file: string; code: string }> = [];
  for (const agent of readdirSync(AGENTS_DIR)) {
    const dir = path.join(AGENTS_DIR, agent, "src", "workflow");
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry);
      if (!entry.endsWith(".ts") || !statSync(file).isFile()) continue;
      found.push({ agent, file: path.relative(REPO_ROOT, file).replaceAll("\\", "/"), code: stripComments(readFileSync(file, "utf8")) });
    }
  }
  return found;
}

/** The argument text of each `throw new WorkflowHeld(...)`, by brace matching. */
function holdSites(): Array<{ agent: string; file: string; message: string }> {
  const sites: Array<{ agent: string; file: string; message: string }> = [];
  for (const { agent, file, code } of workflowSources()) {
    const needle = "throw new WorkflowHeld(";
    let from = 0;
    for (;;) {
      const at = code.indexOf(needle, from);
      if (at < 0) break;
      let depth = 0;
      let j = at + needle.length - 1;
      for (; j < code.length; j += 1) {
        if (code[j] === "(") depth += 1;
        else if (code[j] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      sites.push({ agent, file, message: code.slice(at + needle.length, j).replace(/\s+/gu, " ").trim() });
      from = j + 1;
    }
  }
  return sites;
}

const SITES = holdSites();

describe("every hold is a deliberate one", () => {
  it("found the holds at all, so the check cannot pass by reading nothing", () => {
    // Anti-vacuity. A renamed exception, a moved directory or a broken walker
    // must fail here rather than quietly reporting a clean sweep. 31 sites on
    // 2026-09-25; the floor is deliberately below that so removing a hold
    // (which is the good direction) does not fail the suite.
    expect(SITES.length).toBeGreaterThan(20);
    expect(new Set(SITES.map((s) => s.agent)).size).toBeGreaterThan(5);
  });

  it("leaves no hold unaccounted for", () => {
    const unlisted = SITES.filter(
      (site) => !(HOLD_MANIFEST[site.agent] ?? []).some((entry) => site.message.includes(entry.match)),
    ).map((site) => `${site.file}: ${site.message.slice(0, 90)}`);
    expect(
      unlisted,
      "a hold ends a run with nothing for the client — add it to HOLD_MANIFEST with the reason nothing exists to deliver there:\n" + unlisted.join("\n"),
    ).toEqual([]);
  });

  it("keeps no entry that no longer matches a hold", () => {
    // The other direction, which is what stops the register rotting into a
    // description of a program that has moved on.
    const stale: string[] = [];
    for (const [agent, entries] of Object.entries(HOLD_MANIFEST)) {
      for (const entry of entries) {
        if (!SITES.some((site) => site.agent === agent && site.message.includes(entry.match))) {
          stale.push(`${agent}: "${entry.match}"`);
        }
      }
    }
    expect(stale, "these manifest entries match no hold any more — the hold moved or went away:\n" + stale.join("\n")).toEqual([]);
  });

  it("names an agent that exists for every key", () => {
    const agents = new Set(readdirSync(AGENTS_DIR));
    expect(Object.keys(HOLD_MANIFEST).filter((key) => !agents.has(key))).toEqual([]);
  });
});

describe("what each entry has to say", () => {
  const entries: Array<[string, HoldSite]> = Object.entries(HOLD_MANIFEST).flatMap(([agent, list]) => list.map((entry): [string, HoldSite] => [agent, entry]));

  it("gives a real reason, not a restatement of the message", () => {
    for (const [agent, entry] of entries) {
      expect(entry.why.length, `${agent}: "${entry.match}" has no reason worth reading`).toBeGreaterThan(40);
      expect(entry.why, `${agent}: "${entry.match}" restates its own message`).not.toBe(entry.match);
    }
  });

  it("says what delivering instead would look like, for every hold that discards work", () => {
    // `after-work` is the shape PR #231 fixed four times over: something
    // exists by the time the hold fires. Recording one is allowed; recording
    // one without saying what the fix delivers is how the debt becomes
    // invisible again.
    for (const [agent, entry] of entries) {
      if (entry.stage !== "after-work") continue;
      expect(entry.ifFixed, `${agent}: "${entry.match}" discards work and does not say what shipping instead would be`).toBeTruthy();
      expect(entry.ifFixed!.length).toBeGreaterThan(60);
    }
  });

  it("keeps the count of work-discarding holds visible", () => {
    // Not a ceiling anybody has to argue about — a number that has to be
    // changed on purpose. It went 5 → 1 on 2026-09-24/25 (PR #231 fixed four:
    // landing-builder, seo-geo's fix-generation gate, reputation, campaign).
    const afterWork = entries.filter(([, entry]) => entry.stage === "after-work");
    expect(afterWork.map(([agent, entry]) => `${agent}: ${entry.match}`)).toEqual([
      "branded-shorts-agent: style exploration rejected",
      "seo-geo-agent: fix drafting did not clear its own output validation",
    ]);
  });
});
