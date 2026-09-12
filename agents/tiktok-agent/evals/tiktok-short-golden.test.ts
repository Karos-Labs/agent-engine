import { describe, expect, it } from "vitest";
import { TIKTOK_GOLDEN_RUNS, tikTokGoldenRunsFor } from "./src/golden-runs.js";
import { runTikTokDeterministicAssertions } from "./src/run-assertions.js";

/**
 * The endorsed scripts pass every rule the pipeline enforces in code, and a
 * script that breaks one of those rules fails the named check. A prompt or
 * lint change that would send an endorsed script back to the writer shows up
 * here before it ships (RFC-01 §12; plan item 2.6, 2026-09-10).
 */
describe("TikTok agent golden runs — deterministic assertions", () => {
  it("has golden runs in both languages", () => {
    expect(TIKTOK_GOLDEN_RUNS.length).toBeGreaterThanOrEqual(3);
    expect(tikTokGoldenRunsFor("en").length).toBeGreaterThan(0);
    expect(tikTokGoldenRunsFor("he").length).toBeGreaterThan(0);
  });

  for (const goldenRun of TIKTOK_GOLDEN_RUNS) {
    it(`${goldenRun.id}: the endorsed script passes every check`, async () => {
      const results = await runTikTokDeterministicAssertions(goldenRun);
      expect(results.map((r) => r.check)).toEqual([
        "script.structure",
        "script.voice",
        "script.shots",
        "script.pitch",
        "script.dashes",
        "script.duration",
        "gate.noPlaceholder",
        "gate.brandCompliance",
        "gate.leakCheck",
        "gate.numbersSourced",
      ]);
      for (const result of results) {
        expect(result.verdict, `${result.check} failed: ${result.reason ?? "(no reason)"}`).toBe("pass");
      }
    });

    it(`${goldenRun.id}: is deterministic — running it twice gives identical verdicts`, async () => {
      const first = await runTikTokDeterministicAssertions(goldenRun);
      const second = await runTikTokDeterministicAssertions(goldenRun);
      expect(first).toEqual(second);
    });
  }

  const base = () => TIKTOK_GOLDEN_RUNS[0]!;
  const withBeats = (edit: (beats: (typeof TIKTOK_GOLDEN_RUNS)[number]["endorsedOutput"]["beats"]) => (typeof TIKTOK_GOLDEN_RUNS)[number]["endorsedOutput"]["beats"]) => {
    const run = base();
    return { ...run, endorsedOutput: { ...run.endorsedOutput, beats: edit(run.endorsedOutput.beats.map((b) => ({ ...b }))) } };
  };
  const failing = async (run: (typeof TIKTOK_GOLDEN_RUNS)[number], check: string) => {
    const results = await runTikTokDeterministicAssertions(run);
    const result = results.find((r) => r.check === check)!;
    expect(result, `no result for ${check}`).toBeDefined();
    return result;
  };

  it("catches a regression: a beat repeating another's line fails script.structure", async () => {
    const run = withBeats((beats) => {
      beats[2]!.narration = beats[1]!.narration;
      return beats;
    });
    expect((await failing(run, "script.structure")).verdict).toBe("content_fail");
  });

  it("catches a regression: a sentence past a breath, or the conference-slide register, fails script.voice", async () => {
    const long = withBeats((beats) => {
      beats[1]!.narration = "A plan before a retainer tells you the channels, the timing, the metrics and the budget you are committing to before anyone has asked you to sign.";
      return beats;
    });
    expect((await failing(long, "script.voice")).reason).toMatch(/word sentence/);
    const slide = withBeats((beats) => {
      beats[1]!.onScreenText = "Leverage the ecosystem";
      return beats;
    });
    expect((await failing(slide, "script.voice")).reason).toContain("corporate cadence");
  });

  it("catches a regression: three beats in one place fails script.shots", async () => {
    const run = withBeats((beats) => {
      beats[0]!.stockQuery = "empty office desk night";
      beats[1]!.stockQuery = "office chair window";
      beats[2]!.stockQuery = "office corridor lights";
      return beats;
    });
    expect((await failing(run, "script.shots")).reason).toContain("office");
  });

  it("catches a regression: a last beat that sells fails script.pitch, unless the brief asked for a call to action", async () => {
    const run = withBeats((beats) => {
      beats[beats.length - 1]!.narration = "Book a call and we will show you the plan.";
      return beats;
    });
    expect((await failing(run, "script.pitch")).verdict).toBe("content_fail");
    const asked = { ...run, input: { ...run.input, runDirection: "End with a call to action to book a call." } };
    expect((await failing(asked, "script.pitch")).verdict).toBe("pass");
  });

  it("catches a regression: an em dash or an exclamation mark fails script.dashes", async () => {
    const dash = withBeats((beats) => {
      beats[0]!.narration = "If the plan comes after the contract — you're buying faith.";
      return beats;
    });
    expect((await failing(dash, "script.dashes")).verdict).toBe("content_fail");
    const bang = withBeats((beats) => {
      beats[0]!.onScreenText = "Plan first!";
      return beats;
    });
    expect((await failing(bang, "script.dashes")).verdict).toBe("content_fail");
  });

  it("catches a regression: a short outside 20–40 seconds fails script.duration", async () => {
    const run = withBeats((beats) => beats.map((b) => ({ ...b, seconds: 4 as const })));
    expect((await failing(run, "script.duration")).reason).toContain("16s");
  });

  it("catches a regression: a figure with no source fails gate.numbersSourced", async () => {
    const run = withBeats((beats) => {
      beats[1]!.narration = "Teams that ask for the plan first close 43% faster.";
      return beats;
    });
    expect((await failing(run, "gate.numbersSourced")).verdict).toBe("content_fail");
  });
});
