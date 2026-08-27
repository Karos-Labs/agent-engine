/**
 * Every model id this codebase names must have a price (SCRUM-364 / AU66).
 *
 * ## Why a CI check rather than a runtime throw
 *
 * There are 27 model declarations in this repo and every one is a static
 * string literal. Nothing about "is this model priced" needs to wait for a
 * production run to find out — the same principle AU59 applied to the
 * OpenAI-compatible adapter: decline at WIRING time, not at call time.
 *
 * A runtime throw cannot be the mechanism here, and deliberately is not one.
 * `computeStepCostUsd` runs AFTER the model call, so throwing there would
 * destroy a completed step's output while the money stays spent. The runtime
 * backstop belongs at model SELECTION, before anything is billed.
 *
 * ## Why it matters even though nothing is mispriced today
 *
 * `DEFAULT_MODEL_PRICING` is Sonnet's own rate, $3/$15. That is not a neutral
 * placeholder — it is the rate of the model 26 of 27 declarations already use.
 * So an unpriced id produces a number that is not merely wrong but PLAUSIBLE,
 * in both directions:
 *
 *   - add Opus and every Opus step understates by 5x
 *   - the failover target `gemini-1.5-flash` (unpriced when this check was
 *     written) OVERSTATED by roughly 40x
 *
 * Neither looks like a bug in a report. That is the failure mode.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { MODEL_PRICING, UNIT_PRICING } from "../packages/core/src/telemetry/pricing.js";

const repoRoot = path.resolve(__dirname, "..");

/**
 * Model ids are recognisable by vendor prefix rather than by where they appear.
 * Matching on `model:` alone would miss the two places that actually bite: a
 * `??` default (`CLAUDE_FALLBACK_GEMINI_MODEL ?? "gemini-1.5-flash"`, which is
 * exactly how the unpriced failover target hid) and an id passed positionally.
 */
const MODEL_ID = /["'`](claude-[a-z0-9.@-]+|gemini-[a-z0-9.@-]+|gpt-[a-z0-9.@-]+|llama-[a-z0-9.@-]+|mistral-[a-z0-9.@-]+|imagen-[a-z0-9.@-]+|veo-[a-z0-9.@-]+)["'`]/g;

/**
 * Strings that look like model ids and are not.
 *
 * Kept as an explicit list rather than a cleverer regex: each entry is a claim
 * someone can check, and a list that grows is itself a signal.
 */
const NOT_MODEL_IDS = new Set<string>([
  // Env var VALUES for route selection, not models.
  "gemini-direct",
  "gemini-agent-platform",
  // A `provider:` label on a media candidate — the source that produced an
  // image, not the SKU that billed it. `image.generate` reports the real SKU
  // separately, via `AgentToolOutcome.usage`.
  "gemini-image",
]);

/**
 * Ids that are named in executable code, have no price, and are NOT a build
 * failure — each because a decision is pending, with a ticket.
 *
 * Same discipline as `CapabilityDefinition.pendingBuild.ticket` (the capability-by-product work): an
 * exception without a named owner is how a check quietly becomes decorative.
 * Entries here are printed loudly on every run. A model id NOT on this list
 * still fails the build, which is the mechanism.
 */
const UNPRICED_PENDING_DECISION: Record<string, string> = {
  "veo-2.0-generate-001":
    "karos-media's DEFAULT_VIDEO_MODEL. Unpriced deliberately: no per-second rate for this exact id could be verified against a page actually read (the pricing table renders past the fetch limit), and a search result suggesting it is deprecated with a mid-2026 shutdown could not be confirmed at source either. Guessing a rate would produce a plausible wrong number, which is the failure this whole table exists to prevent. The video line is UNRUNNABLE pending SCRUM-362 regardless, so nothing bills through this today. Needs: confirm the model's lifecycle status and rate, or replace the default.",
};

/**
 * Strips comments before scanning.
 *
 * The first run of this check reported `claude-opus-5` and `claude-sonnet-5`
 * as unpriced. Both appear exactly once, in a DOC COMMENT explaining the
 * dateless-id convention — nothing routes to them. That is the house rule in
 * miniature: a citation into executable code is reliable, a citation into a
 * comment is not, and a checker that cannot tell them apart produces exactly
 * the noise that gets checks switched off.
 *
 * It also means this check cannot see an id supplied at RUN time through
 * `MODEL_STEP_<ID>_MODEL`. That gap is covered by `assertModelPriced` at model
 * selection — before anything is billed, rather than after.
 */
function stripComments(source: string): string {
  const block = /\/\*[\s\S]*?\*\//g;
  // `[^:]` keeps `https://` and `file://` out of the line-comment match.
  const line = /(^|[^:])\/\/.*/gm;
  return source.replace(block, " ").replace(line, "$1 ");
}

/** Agent Platform dates a snapshot with `@` where the Claude API uses `-`; both name one model. */
function canonical(id: string): string {
  return id.replace("@", "-");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

export interface PricingGap {
  readonly modelId: string;
  readonly sites: readonly string[];
}

/**
 * Every model id named in shipping source that has no price row.
 *
 * Tests and the pricing table itself are excluded: a test naming an unpriced
 * model is asserting something about the unpriced case, and the table names
 * every id it prices by definition.
 */
export function unpricedModelIds(): PricingGap[] {
  const sites = new Map<string, string[]>();

  for (const dir of ["packages", "apps", "agents"]) {
    for (const file of sourceFiles(path.join(repoRoot, dir))) {
      const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
      if (rel.includes("__tests__") || rel.endsWith("telemetry/pricing.ts")) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(MODEL_ID)) {
        const id = canonical(match[1]!);
        if (NOT_MODEL_IDS.has(id)) continue;
        if (MODEL_PRICING[id] || UNIT_PRICING[id]) continue;
        if (id in UNPRICED_PENDING_DECISION) continue;
        (sites.get(id) ?? sites.set(id, []).get(id)!).push(rel);
      }
    }
  }

  return [...sites.entries()]
    .map(([modelId, found]) => ({ modelId, sites: [...new Set(found)].sort() }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

if (require.main === module) {
  const gaps = unpricedModelIds();

  const pending = Object.entries(UNPRICED_PENDING_DECISION);
  console.log(`--- UNPRICED, DECISION PENDING (${pending.length}) — reported, not fatal ---`);
  for (const [id, why] of pending) console.log(`  ${id}
    ${why}`);
  if (pending.length === 0) console.log("  (none)");
  console.log();

  console.log(`--- MODEL IDS WITHOUT A PRICE (${gaps.length}) — hard failure ---`);
  for (const gap of gaps) console.log(`  ${gap.modelId}\n    ${gap.sites.join("\n    ")}`);
  if (gaps.length === 0) console.log("  (none)");
  console.log(`\npriced by token: ${Object.keys(MODEL_PRICING).length} | priced by unit: ${Object.keys(UNIT_PRICING).length}`);

  if (gaps.length > 0) {
    console.error(
      `\ncheck-model-pricing: ${gaps.length} model id(s) named in source with no price row. ` +
        "Add them to MODEL_PRICING (token-billed) or UNIT_PRICING (per-image/per-second) with a checkable source. " +
        "An unpriced id silently bills at DEFAULT_MODEL_PRICING, which is Sonnet's own rate — a plausible wrong number, not an obviously broken one.",
    );
    process.exit(1);
  }
}
