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

  it.each(metered.map(({ file }) => toPosix(file)))(
    "%s passes usage to success()",
    (rel) => {
      const source = metered.find(({ file }) => file.endsWith(path.basename(rel)))!.source;
      // `success(result, usage)` — a second argument. A metered tool returning
      // a bare `success(result)` is the exact shape that recorded $0.000000 for
      // two real, billed image generations.
      expect(source, `${rel} calls a metered API but reports no units — its steps will record $0`).toMatch(
        /return success<[^>]+>\([\s\S]*?,\s*\[\s*\{\s*model/,
      );
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
