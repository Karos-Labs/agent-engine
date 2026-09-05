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
 * Empty since the setup agents stopped being products. `linkedin-setup-agent`
 * and `reddit-setup-agent` were the only two entries: they parsed a filled
 * intake form and persisted it as the charter the drafting agents later read,
 * `wf.step.code` end to end. That work now runs as a `00-channel-setup`
 * pre-flight inside `linkedin-agent`/`reddit-agent`, both of which draft and so
 * both of which must honour a typed direction.
 *
 * Kept rather than deleted because the exemption MECHANISM is what this file
 * needs: the next agent that genuinely has no model step should be named here
 * with its reason, not quietly dropped from the sweep.
 */
const NO_MODEL_STEP = new Set<string>([]);

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
 * Derived rather than mapped, so a new agent joins the sweep by existing rather
 * than by someone remembering to add a table row. Every product is its own
 * directory of the same name; a product id with no directory is a real mismatch
 * between `KNOWN_PRODUCT_IDS` and the tree, and failing loudly here is better
 * than silently scanning some other package's source.
 */
function packageDirFor(productId: string): string {
  const dir = path.join(AGENTS_ROOT, productId, "src");
  statSync(dir);
  return dir;
}

const DRAFTING_PRODUCTS = KNOWN_PRODUCT_IDS.filter((id) => !NO_MODEL_STEP.has(id));

describe("run direction reaches every agent that drafts anything", () => {
  it.each(DRAFTING_PRODUCTS)("%s reads the typed direction and hands it to a model step", (productId) => {
    const files = sourceFiles(packageDirFor(productId));
    const combined = files.map((f) => readFileSync(f, "utf8")).join("\n");

    // `readRunDirection` is how the brief gets off the run input at all.
    //
    // BOTH HALVES USED TO ADMIT AN ALTERNATIVE, and both alternatives were
    // wrong. This accepted `readRichRunInput` "which tiktok has used since
    // before the wrapper existed", and the spread check accepted a bare
    // mention of `customPrompt` — so tiktok-agent satisfied a test named for
    // this promise while its commentary step, the one that writes the caption
    // a client reads, received no direction at all. A client's typed sentence
    // reached it only by being force-promoted to the run's topic, with none of
    // `looksLikeTopic`'s protection, and the structured brief (audience, tone,
    // CTA, must-include, keywords) reached it never. An escape hatch in a
    // coverage test is worth exactly as much as the promise it exempts.
    expect(combined, `${productId} never reads the run's brief via readRunDirection`).toMatch(
      /readRunDirection\(/,
    );

    // And reading it is not enough — it has to reach a step that writes. The
    // helper is what spreads it in, and it omits the key when nobody typed
    // anything, which is the behaviour every agent should share.
    expect(combined, `${productId} reads the direction but never passes it to a model step`).toMatch(
      /runDirectionField\(/,
    );
  });

  it("exempts only agents that genuinely have no model step", () => {
    // Vacuous today, and deliberately kept: it is the check that would fire on
    // the first exemption somebody adds without one being warranted.
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
