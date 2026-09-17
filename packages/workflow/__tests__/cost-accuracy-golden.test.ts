import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { computeStepCostUsd, computeToolCostUsd, extractToolUsage } from "@agent-engine/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The recurring cost-accuracy check (SCRUM-364 / AU66 task 4).
 *
 * ## What this exists to catch
 *
 * A measured Instagram run (`pubsub-21560857620229716`) reported $0.565829.
 * Its two `gemini-2.5-flash-image` invocations — confirmed independently
 * against Vertex's own publisher metrics — were recorded at $0.000000, because
 * `image.generate` is a TOOL and no tool had a cost path at all. ~14%,
 * invisible, and reading as a completed and fully-accounted run.
 *
 * So the golden total below deliberately MIXES tokens and per-unit media. A
 * check that asserted token cost alone would have passed happily throughout the
 * entire period the bug existed. That is the whole point: this must fail on the
 * precise failure that was found, not on a nearby one.
 *
 * ## Why a fixture rather than a live run
 *
 * A live run costs money, needs credentials, and produces a different number
 * every time — so it could only ever assert a loose band, and a loose band is
 * how a 14% error survives. These are exact numbers through the real pricing
 * code. The live counterpart is the periodic reconciliation in
 * `docs/COST-ACCURACY-REVIEW.md`, which is a different instrument for a
 * different job: this one catches regressions, that one catches reality
 * drifting away from the table.
 */

/**
 * Modelled on the real run's shape: agent turns that burn tokens, plus a media
 * step that consumes units and burns none.
 */
const GOLDEN_RUN = {
  agentTurns: [
    { model: "claude-sonnet-4-6", inputTokens: { cached: 0, uncached: 60_000 }, outputTokens: 15_000 },
    { model: "claude-sonnet-4-6", inputTokens: { cached: 20_000, uncached: 7_233 }, outputTokens: 8_280 },
  ],
  // What `06d-generate-images` actually did in that run.
  mediaUnits: [{ model: "gemini-2.5-flash-image", unit: "image", quantity: 2 }],
} as const;

describe("cost accuracy: the golden run", () => {
  const tokenCost = GOLDEN_RUN.agentTurns.reduce((sum, t) => sum + computeStepCostUsd(t.model, t.inputTokens, t.outputTokens), 0);
  const unitCost = computeToolCostUsd(GOLDEN_RUN.mediaUnits);

  it("prices the token half to the cent it has always priced it to", () => {
    // 67,233 uncached @ $3/1M + 20,000 cached @ $0.30/1M + 23,280 out @ $15/1M
    expect(tokenCost).toBeCloseTo(0.556_899, 6);
  });

  it("prices the MEDIA half, which used to be recorded as exactly zero", () => {
    expect(unitCost).toBeCloseTo(0.078, 6);
    expect(unitCost, "the regression under test is this reading 0").toBeGreaterThan(0);
  });

  it("totals both dimensions — an unpriced new unit changes this number", () => {
    expect(tokenCost + unitCost).toBeCloseTo(0.634_899, 6);
  });

  it("shows the size of the error this check was built after", () => {
    // Stated as a ratio rather than a sentence in a doc, so it stays true.
    const understatementIfMediaIgnored = 1 - tokenCost / (tokenCost + unitCost);
    expect(understatementIfMediaIgnored).toBeGreaterThan(0.1);
    expect(understatementIfMediaIgnored).toBeLessThan(0.2);
  });
});

/**
 * The guard that catches the NEXT one.
 *
 * Derived rather than restated, for the reason AU54 learned the hard way: a
 * hand-maintained list of metered tools is another copy of the truth, and it
 * goes stale exactly when someone adds the tool it was supposed to cover.
 *
 * The derivation: a tool that makes a generative-media CALL is a tool that
 * spends money, and must report what it consumed on its success path.
 */
describe("cost accuracy: every metered tool reports what it consumed", () => {
  /**
   * The metered CALL, not the import.
   *
   * The first version of this derivation looked for `from "@google/genai"` and
   * found nothing — every media tool depends on a narrow structural interface
   * instead of the SDK (the same discipline as `MessagesApiClient`), so only
   * the wiring file imports it. The premise assertion below caught that, which
   * is the only reason this is not silently covering zero files.
   *
   * These method names are what actually costs money, and a tool cannot call a
   * generative API without naming one of them.
   */
  const GENERATIVE_CALLS = ["generateContent", "generateVideos", "generateImages"];

  function toolSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) toolSources(full, out);
      else if (entry.endsWith(".ts") && !full.includes("__tests__")) out.push(full);
    }
    return out;
  }

  const metered = toolSources(path.join(repoRoot, "packages", "tools"))
    .map((file) => ({ file, source: readFileSync(file, "utf8") }))
    .filter(({ source }) => GENERATIVE_CALLS.some((call) => source.includes(`${call}(`)))
    .filter(({ source }) => source.includes("success<"));

  it("finds the metered tools at all — the premise, asserted rather than assumed", () => {
    // Without this the suite passes by covering nothing — which is exactly
    // what happened on the first attempt at the derivation above.
    expect(metered.length, `no tool calls any of ${GENERATIVE_CALLS.join(", ")}`).toBeGreaterThan(0);
  });

  const toPosix = (file: string): string => path.relative(repoRoot, file).split(path.sep).join("/");

  /**
   * Whether any `return success(...)` in this source passes a SECOND
   * top-level argument, which is where usage goes.
   *
   * ## Why this is a scan and not a regular expression
   *
   * It was `/return success<[^>]+>\([\s\S]*?,\s*\[\s*\{\s*model/` — a
   * specific encoding of the property the comment below states, and a
   * strictly narrower one. It demanded that the usage argument be a LITERAL
   * array whose first key is `model`, so a tool that computes its units
   * (`served.map(([m, quantity]) => ({ model: m, unit: "image", quantity }))`,
   * which is what per-model billing looks like when a call can fall between
   * models) failed a guard whose stated subject it satisfies.
   *
   * Widening the pattern is not available either: the RESULT argument of a
   * metered tool routinely carries a `model` field of its own, so any regex
   * loose enough to accept a computed second argument also matches the first
   * one and the guard stops being able to fail. Counting commas at depth one
   * is the thing the sentence actually means.
   */
  function passesUsageToSuccess(source: string): boolean {
    for (let at = source.indexOf("return success"); at >= 0; at = source.indexOf("return success", at + 1)) {
      const open = source.indexOf("(", at);
      if (open < 0) continue;
      let depth = 0;
      for (let i = open; i < source.length; i += 1) {
        const ch = source[i]!;
        if (ch === "(" || ch === "[" || ch === "{") depth += 1;
        else if (ch === ")" || ch === "]" || ch === "}") {
          depth -= 1;
          if (depth === 0) break; // the call closed with one argument
        } else if (ch === "," && depth === 1) return true;
      }
    }
    return false;
  }

  it("the scan can fail — a bare success(result) is caught, and a computed usage argument is not", () => {
    // `guards-that-cannot-fail`: this guard reads source text, so its own
    // premise has to be asserted rather than assumed.
    expect(passesUsageToSuccess("return success<T>({ candidates, model });")).toBe(false);
    expect(passesUsageToSuccess("return success<T>({ model }, [{ model, unit: \"image\", quantity: 1 }]);")).toBe(true);
    expect(passesUsageToSuccess("return success<T>({ model }, served.map((m) => ({ model: m })));")).toBe(true);
    // A comma INSIDE the result object is not a second argument.
    expect(passesUsageToSuccess("return success<T>({ a: 1, b: 2 });")).toBe(false);
  });

  it.each(metered.map(({ file }) => toPosix(file)))(
    "%s passes usage to success()",
    (rel) => {
      const source = metered.find(({ file }) => file.endsWith(path.basename(rel)))!.source;
      // `success(result, usage)` — a second argument. A metered tool returning
      // a bare `success(result)` is the exact shape that recorded $0.000000 for
      // two real, billed image generations.
      expect(passesUsageToSuccess(source), `${rel} calls a metered API but reports no units — its steps will record $0`).toBe(true);
    },
  );
});

describe("cost accuracy: a step's recorded cost is derivable from what it stored", () => {
  it("keeps the units, not just the dollars", () => {
    // The run that exposed this gap could only be reconciled because Vertex's
    // publisher metrics existed OUTSIDE our telemetry. Claude on Vertex emits
    // none, Firestore stores no token counts, and BigQuery merges cached and
    // uncached input into one column. Storing units is what keeps this number
    // checkable without a third party.
    const outcome = { status: "success" as const, result: {}, usage: GOLDEN_RUN.mediaUnits };
    const recovered = extractToolUsage(outcome);
    expect(recovered).toEqual(GOLDEN_RUN.mediaUnits);
    expect(computeToolCostUsd(recovered)).toBeCloseTo(0.078, 6);
  });
});

/**
 * AU72 / SCRUM-372: a telemetry writer that hides its own failure.
 *
 * Production wrote ZERO rows for its entire life. `agent-engine-sa@karoscmo`
 * had no grant on `karoscmo:bi_telemetry`, every insert was denied, and the
 * catch logged at WARNING and continued — so every deploy reported success
 * while the capability was dead. Prep had the grant and 329 rows, which is
 * exactly why nobody noticed: the sink anyone checked was the one that worked.
 *
 * The missing role was the symptom. These pin the fix to the silence.
 */
describe("AU72: the telemetry sink cannot fail quietly", () => {
  const source = readFileSync(path.join(repoRoot, "packages", "telemetry", "src", "span-helpers.ts"), "utf8");

  it("logs a denied insert at ERROR, not WARNING", () => {
    const insertCatch = source.slice(source.indexOf("agent_runs_bi insert failed") - 900, source.indexOf("agent_runs_bi insert failed") + 200);
    expect(insertCatch, "a permission denial is not a warning").toContain('severity: "ERROR"');
    expect(insertCatch).not.toContain('severity: "WARNING"');
  });

  it("emits a stable event string a log-based metric can alert on", () => {
    // Same mechanism AU61 used for model.failover, for the same reason: a rate
    // over time is the only way to notice a failure that never throws.
    expect(source).toContain('event: "telemetry.insert_failed"');
  });

  it("exposes sink health, so a dead writer is visible without grepping logs", () => {
    expect(source).toContain("export function telemetrySinkHealth()");
    const route = readFileSync(path.join(repoRoot, "apps", "agent-server", "src", "routes", "diagnostics.ts"), "utf8");
    expect(route, "the diagnostics endpoint is where a human looks for what is switched off").toContain("telemetrySink: telemetrySinkHealth()");
  });

  it("does not count an unconfigured sink as a failed one", () => {
    // The three states — writing, never configured, denied — looked identical
    // from outside. Conflating the last two would put two of them back.
    expect(source).toMatch(/if \(!table\) return;\s*\n\s*sinkHealth\.attempted \+= 1;/);
  });
});
