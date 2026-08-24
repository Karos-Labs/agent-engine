import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { KNOWN_PRODUCT_IDS } from "../src/wiring/workflows.js";

/**
 * EVERY DISPATCHABLE AGENT HONOURS A TYPED RUN DIRECTION.
 *
 * The portal offers one field — "direction for this run" — on every agent it
 * can dispatch. That field is a promise, and the failure mode when an agent
 * ignores it is the worst kind: the run succeeds, the deliverable is fine on its
 * own terms, and it simply is not what the person asked for. Nothing errors and
 * nothing in the trace says why.
 *
 * This is a source scan, and deliberately so. Proving it per agent through a
 * workflow run would mean fourteen harnesses, each with its own stubbed tools
 * and its own router, to assert one spread — and the check that actually
 * matters is about the NEXT agent someone adds, which no existing harness would
 * cover. What this cannot see is whether the direction reaches the right step;
 * each agent's own tests carry that.
 *
 * EXEMPTIONS ARE NAMED AND JUSTIFIED, never inferred from an agent's shape. An
 * exemption list that grows by convenience is how a promise like this stops
 * being true.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_ROOT = path.join(HERE, "..", "..", "..", "agents");

/**
 * Agents with no model step at all, so a free-text sentence has nowhere to go.
 *
 * The setup agents parse a filled intake form and persist it as the charter the
 * drafting agents later read — `wf.step.code` end to end. karosCMO hides the
 * direction field for exactly these two, and the two lists have to agree:
 * offering a field no workflow reads is the defect this file is about.
 */
const NO_MODEL_STEP = new Set(["linkedin-setup-agent", "reddit-setup-agent"]);

/** Every `.ts` file under a directory, recursively, excluding build output. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) found.push(full);
  }
  return found;
}

/**
 * The package directory backing a product id.
 *
 * Derived rather than mapped: `linkedin-setup-agent` lives in `setup-agents`
 * alongside its reddit sibling, and every other product is its own directory of
 * the same name. A hardcoded table would need editing for each new agent, which
 * is the maintenance this test is trying not to add.
 */
function packageDirFor(productId: string): string {
  const own = path.join(AGENTS_ROOT, productId);
  try {
    if (statSync(own).isDirectory()) return path.join(own, "src");
  } catch {
    // Falls through to the shared setup package below.
  }
  return path.join(AGENTS_ROOT, "setup-agents", "src");
}

const DRAFTING_PRODUCTS = KNOWN_PRODUCT_IDS.filter((id) => !NO_MODEL_STEP.has(id));

describe("run direction reaches every agent that drafts anything", () => {
  it.each(DRAFTING_PRODUCTS)("%s reads the typed direction and hands it to a model step", (productId) => {
    const files = sourceFiles(packageDirFor(productId));
    const combined = files.map((f) => readFileSync(f, "utf8")).join("\n");

    // `readRunDirection` (or `readRichRunInput`, which tiktok has used since
    // before the wrapper existed) is how the field gets off the run input at
    // all. Without it the value is simply dropped.
    expect(combined, `${productId} never reads the run's typed direction`).toMatch(
      /readRunDirection|readRichRunInput/,
    );

    // And reading it is not enough — it has to reach a step that writes. The
    // helper is what spreads it in, and it omits the key when nobody typed
    // anything, which is the behaviour every agent should share.
    expect(combined, `${productId} reads the direction but never passes it to a model step`).toMatch(
      /runDirectionField\(|customPrompt/,
    );
  });

  it("exempts only agents that genuinely have no model step", () => {
    for (const productId of NO_MODEL_STEP) {
      const files = sourceFiles(packageDirFor(productId));
      const combined = files.map((f) => readFileSync(f, "utf8")).join("\n");
      // The justification, asserted rather than trusted: if a setup agent ever
      // grows a `wf.step.agent`, its exemption stops being true and this fails
      // instead of quietly ignoring what someone typed.
      expect(combined, `${productId} has a model step now — it should honour the run direction`).not.toContain(
        "wf.step.agent(",
      );
    }
  });

  it("covers every product the server can dispatch, so a new agent is not skipped", () => {
    // The list under test comes from KNOWN_PRODUCT_IDS, which is what
    // `buildWorkflowForProduct` switches on — so a new dispatchable agent joins
    // this test by existing, not by someone remembering to add it here.
    expect(DRAFTING_PRODUCTS.length + NO_MODEL_STEP.size).toBe(KNOWN_PRODUCT_IDS.length);
    expect(DRAFTING_PRODUCTS.length).toBeGreaterThan(10);
  });
});
