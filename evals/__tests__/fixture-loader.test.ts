import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadGoldenRunFixture } from "../src/fixture-loader.js";

/**
 * AU16 / SCRUM-300: the mechanical loader every per-agent `evals/golden-runs.ts`
 * hand-rolled identically (readFileSync + fileURLToPath + path.join + `schema.parse(JSON.parse(...))`)
 * eight times, now lifted into the root `evals/` package so a ninth agent uses
 * this instead of writing its own copy.
 *
 * `loadGoldenRunFixture` did not exist before this ticket — on unmodified
 * `main`, `../src/fixture-loader.js` does not resolve at all.
 */
describe("loadGoldenRunFixture", () => {
  it("loads and validates a real fixture relative to the CALLING module's own import.meta.url", () => {
    // Reuses the root package's own real fixture (evals/golden-runs/linkedin-post-draft.json)
    // to prove path resolution is relative to the caller, not to fixture-loader.ts's own location.
    const run = loadGoldenRunFixture(
      import.meta.url,
      "linkedin-post-draft.json",
      z.object({ id: z.string(), endorsedOutput: z.object({ text: z.string() }) }).passthrough(),
    );
    expect(run.id).toBeTruthy();
    expect(run.endorsedOutput.text.length).toBeGreaterThan(0);
  });

  it("fails fast — a drifted fixture never reaches the caller silently", () => {
    const tooStrict = z.object({ thisFieldWillNeverBePresent: z.string() });
    expect(() => loadGoldenRunFixture(import.meta.url, "linkedin-post-draft.json", tooStrict)).toThrow();
  });

  it("throws a real filesystem error for a fixture that doesn't exist, not a silent empty result", () => {
    expect(() => loadGoldenRunFixture(import.meta.url, "does-not-exist.json", z.unknown())).toThrow(/ENOENT|no such file/i);
  });
});
