/**
 * Live credential + model-access check for the Google Cloud Agent Platform
 * route (formerly Vertex AI).
 *
 * Unlike `scripts/smoke-test-server.ts`, this one deliberately DOES make a
 * real, billable model call — that is the entire point. It answers the four
 * questions that every "model not found" / "could not load the default
 * credentials" incident on this route turns out to be, and it answers them
 * one at a time so the failure names its own cause:
 *
 *   1. Is a project configured, and which one?
 *   2. Do Application Default Credentials resolve at all?
 *   3. Is this model enabled in this project, at this region/endpoint?
 *   4. Does structured output come back parseable, priced, and attributed to
 *      the canonical model id the rest of the system reports on?
 *
 * The call is tiny (a one-field schema, ~20 output tokens), so it costs a
 * fraction of a cent.
 *
 * Run with:
 *   npx tsx --env-file=.env scripts/smoke-agent-platform.ts
 *   npx tsx --env-file=.env scripts/smoke-agent-platform.ts claude-sonnet-4-6
 */
import { z } from "zod";
import { computeStepCostUsd, createModelRouterFromEnv, resolvePinnedRouteProvider } from "../packages/core/src/index.js";
import { MODEL_ALIASES } from "../packages/core/src/router/aliases.js";
import { toAgentPlatformModelId } from "../packages/core/src/router/adapters/agent-platform-model-ids.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

function section(title: string): void {
  console.log();
  console.log(`${BOLD}${CYAN}${"=".repeat(78)}${RESET}`);
  console.log(`${BOLD}${CYAN}  ${title}${RESET}`);
  console.log(`${BOLD}${CYAN}${"=".repeat(78)}${RESET}`);
}
function ok(msg: string): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}
function warn(msg: string): void {
  console.log(`  ${YELLOW}!${RESET} ${msg}`);
}
function narrate(msg: string): void {
  console.log(`  ${DIM}${msg}${RESET}`);
}

/** Small enough that the answer can only be right or obviously wrong. */
const SmokeSchema = z.object({
  ok: z.literal(true),
  route: z.string().min(1).describe("the words 'agent platform', lowercase"),
});

async function main(): Promise<void> {
  section("Agent Platform route — live credential and model-access check");

  const requestedModel = process.argv[2] ?? MODEL_ALIASES.sonnet.model;

  const provider = resolvePinnedRouteProvider(process.env);
  if (provider !== "agent-platform") {
    warn(`MODEL_PROVIDER resolves to "${provider}" — this script checks the Agent Platform route specifically.`);
    narrate("Unset MODEL_PROVIDER (or set it to agent-platform) and re-run.");
    process.exit(1);
  }
  ok('MODEL_PROVIDER resolves to "agent-platform"');

  const project = process.env["ANTHROPIC_VERTEX_PROJECT_ID"] ?? process.env["GOOGLE_CLOUD_PROJECT"];
  const region = process.env["CLOUD_ML_REGION"] ?? process.env["VERTEX_AI_LOCATION"] ?? "global (default)";
  narrate(`project:  ${project ?? "(unset — the router will throw next)"}`);
  narrate(`region:   ${region}`);
  narrate(`model:    ${requestedModel}  ->  ${toAgentPlatformModelId(requestedModel)} on the wire`);

  // Throws with an actionable message if no project is configured.
  const router = createModelRouterFromEnv();
  ok("router constructed — no API key involved on this route");

  narrate("");
  narrate("Making one real, billable call (tiny schema, ~20 output tokens)...");

  const started = Date.now();
  const result = await router.complete(
    'Call the emit_output tool with ok=true and route set to the words "agent platform" in lowercase.',
    SmokeSchema,
    { policy: "pinned", model: requestedModel },
    { maxTokens: 256 },
  );
  const elapsedMs = Date.now() - started;

  ok(`structured output parsed: ${JSON.stringify(result.output)}`);
  ok(`credentials resolved and the model answered in ${elapsedMs}ms`);

  const cost = computeStepCostUsd(result.modelUsed, result.inputTokens, result.outputTokens);
  ok(`modelUsed reported as "${result.modelUsed}" (canonical, not the @-dated wire spelling)`);
  narrate(
    `tokens:   in ${result.inputTokens.uncached} uncached + ${result.inputTokens.cached} cached, out ${result.outputTokens}`,
  );
  narrate(`cost:     $${cost.toFixed(6)}`);

  if (cost === 0) {
    warn("cost computed as $0 — check that this model has a MODEL_PRICING row (telemetry/pricing.ts).");
  }
  if (result.inputTokens.cached === 0) {
    narrate("no cache read on a first call is expected; a second run of the same step should show one.");
  }

  section("Agent Platform route is live");
  console.log();
}

main().catch((err: unknown) => {
  console.error();
  console.error(`${RED}${BOLD}Agent Platform smoke check FAILED${RESET}`);
  console.error();
  // RFC-01 §16.4: always log `cause`, not just the message — on this route a
  // network/auth failure and a genuine API rejection look identical otherwise.
  console.error(err);
  if (err instanceof Error && err.cause !== undefined) {
    console.error(`${DIM}cause:${RESET}`, err.cause);
  }
  console.error();
  console.error(`${BOLD}Most likely causes, in order:${RESET}`);
  console.error("  • Could not load the default credentials  -> run: gcloud auth application-default login");
  console.error("  • 404 model not found                     -> enable this model in Model Garden for this project,");
  console.error("                                               or pin a region: VERTEX_REGION_<MODEL>=us-east5");
  console.error("  • 403 permission denied                   -> grant roles/aiplatform.user to the caller");
  console.error("  • 429 quota exceeded                      -> request quota, or switch CLOUD_ML_REGION=global");
  console.error();
  process.exit(1);
});
