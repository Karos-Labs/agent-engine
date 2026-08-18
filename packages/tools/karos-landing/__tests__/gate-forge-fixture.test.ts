import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createLandingGate } from "../src/gate/gate-tool.js";
import { BrandJsonSchema } from "../src/types.js";
import { testCtx } from "./test-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, "fixtures", "forge");

/**
 * `landing.gate` parity check against the FORGE fixture (RFC-07 Definition
 * of Done #2: "the ported gate.mjs passes on FORGE with the exact same
 * verdict shape"). `engine/gate.mjs` run directly against this same copied
 * fixture (`node engine/gate.mjs --brand fixtures/forge/brand.json --site
 * fixtures/forge/site`) reports `pass: true`, 8/8 colors found, all three
 * font families wired, and no brand-lint violations — this suite asserts
 * `landing.gate` reproduces that verdict, plus the new carry-forward
 * completeness check this port adds on top.
 */
describe("landing.gate: FORGE fixture parity", () => {
  let tmpRoot: string;
  let engineClientsRoot: string;
  let brand: unknown;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "landing-gate-forge-"));
    engineClientsRoot = path.join(tmpRoot, "clients");
    const siteRoot = path.join(engineClientsRoot, "forge", "site");
    await fs.mkdir(siteRoot, { recursive: true });
    await fs.cp(path.join(FIXTURE_ROOT, "site"), siteRoot, { recursive: true });
    brand = JSON.parse(await fs.readFile(path.join(FIXTURE_ROOT, "brand.json"), "utf8"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function makeTool() {
    return createLandingGate({ templateRoot: path.join(tmpRoot, "template"), engineClientsRoot, bundlesRoot: path.join(tmpRoot, "bundles") });
  }

  it("reproduces gate.mjs's PASS verdict on the unmodified FORGE fixture", async () => {
    const tool = makeTool();
    const parsedBrand = BrandJsonSchema.parse(brand);
    const outcome = await tool.execute({ brand: parsedBrand, doBuild: false }, { ctx: testCtx({ clientSlug: "forge" }) });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.verdict).toBe("pass");
    if (outcome.result.verdict === "pass") {
      expect(outcome.result.checks.tokenDrift).toEqual({ colors: 8, missing: 0 });
      expect(outcome.result.checks.fontFidelity).toEqual(["Clash Display", "Inter", "JetBrains Mono"]);
      expect(outcome.result.checks.brandLint).toEqual({ forbidEmDash: false, forbidEnDash: false, forbidExcl: false });
      // FORGE's own two carry-forwards (the progress graph + the coaching chatbot, ENGINE-SPEC §12) both present.
      expect(outcome.result.checks.carryForward).toEqual({ total: 2, missing: [] });
    }
  });

  it("FAILS when a brand color has drifted out of globals.css", async () => {
    const tool = makeTool();
    const mutated = BrandJsonSchema.parse(brand);
    mutated.tokens.colors["ember"] = "#123456"; // not present anywhere in the fixture's globals.css
    const outcome = await tool.execute({ brand: mutated, doBuild: false }, { ctx: testCtx({ clientSlug: "forge" }) });
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.result.verdict).toBe("content_fail");
      if (outcome.result.verdict === "content_fail") {
        expect(outcome.result.hardViolations.some((v) => v.rule === "token-drift")).toBe(true);
      }
    }
  });

  it("FAILS the gate on a carry-forward item that was forgotten in the build", async () => {
    const tool = makeTool();
    const mutated = BrandJsonSchema.parse(brand);
    // Deliberately rare, unrelated vocabulary — words like "pricing"/"configurator"/"rebuild" would
    // coincidentally collide with real, unrelated FORGE fixture text (pricing nav links, a
    // content-schema.ts enum comment, "FORGE ... rebuilds it every week") and false-positive as
    // "present" under the fuzzy word-overlap fallback, which is exactly the kind of accidental
    // match this test must avoid to prove a genuinely-missing item is caught.
    mutated.carryForward.push({ type: "zorblatt-widget", what: "Zorblatt inventory synchronizer widget from the archived intranet portal" });
    const outcome = await tool.execute({ brand: mutated, doBuild: false }, { ctx: testCtx({ clientSlug: "forge" }) });
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.result.verdict).toBe("content_fail");
      if (outcome.result.verdict === "content_fail") {
        expect(outcome.result.checks.carryForward.missing).toContain("Zorblatt inventory synchronizer widget from the archived intranet portal");
        expect(outcome.result.hardViolations.some((v) => v.rule === "carry-forward-missing")).toBe(true);
      }
    }
  });

  it("returns tooling_error when no built site exists yet for this client", async () => {
    const tool = createLandingGate({ templateRoot: path.join(tmpRoot, "template"), engineClientsRoot: path.join(tmpRoot, "clients-empty"), bundlesRoot: path.join(tmpRoot, "bundles") });
    const parsedBrand = BrandJsonSchema.parse(brand);
    const outcome = await tool.execute({ brand: parsedBrand, doBuild: false }, { ctx: testCtx({ clientSlug: "forge" }) });
    expect(outcome.status).toBe("tooling_error");
  });
});
