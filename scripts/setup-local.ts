/**
 * Prepares everything `apps/agent-server` needs to serve a real run on a
 * developer machine, into a single git-ignored `.local/` directory:
 *
 *   1. `.local/prompts/` — every agent's `prompts/` folder merged into the ONE
 *      root `FilePromptStore` expects (`<root>/<promptId>/<version>.md`). The
 *      prompts ship per agent, so `PROMPT_STORE_FILE_ROOT` has nothing valid
 *      to point at until they're collected here.
 *   2. `.local/workspace/` — one seeded demo tenant. Without it every run
 *      stops at `00-intake-check` with status "blocked_intake", since each
 *      workflow reads its whole input from persisted client state.
 *
 * Re-running is safe: prompts are re-copied, and the workspace seed is
 * idempotent by construction (the caller-supplied key IS the path — see
 * WorkspaceStore's own doc comment).
 *
 * Run with:
 *   npm run setup:local            # seeds the "acme" tenant
 *   npm run setup:local -- brand-x # seeds a differently-named tenant
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";

// scripts/*.ts compiles as CommonJS under the root tsconfig (root package.json
// has no "type": "module"), so __dirname is available directly — no import.meta
// needed. Same convention as scripts/demo-agents-run.ts.
const REPO_ROOT = path.resolve(__dirname, "..");
const LOCAL_DIR = path.join(REPO_ROOT, ".local");
const PROMPTS_OUT = path.join(LOCAL_DIR, "prompts");
const WORKSPACE_OUT = path.join(LOCAL_DIR, "workspace");

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function ok(msg: string): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

/** Merges every agent's own `prompts/<promptId>/` directory into one FilePromptStore root, failing loudly if two agents ever ship the same promptId. */
async function collectPrompts(): Promise<number> {
  await fs.rm(PROMPTS_OUT, { recursive: true, force: true });
  await fs.mkdir(PROMPTS_OUT, { recursive: true });

  const agentsDir = path.join(REPO_ROOT, "agents");
  const seen = new Map<string, string>();

  for (const agent of (await fs.readdir(agentsDir, { withFileTypes: true })).filter((e) => e.isDirectory())) {
    const promptsDir = path.join(agentsDir, agent.name, "prompts");
    let promptIds: string[];
    try {
      promptIds = (await fs.readdir(promptsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue; // an agent folder without a prompts/ dir is fine
    }

    for (const promptId of promptIds) {
      const previousOwner = seen.get(promptId);
      if (previousOwner !== undefined) {
        throw new Error(
          `setup-local: promptId "${promptId}" is shipped by both "${previousOwner}" and "${agent.name}" — ` +
            "one shared PromptStore can't serve both. Rename one of them before merging into a single root.",
        );
      }
      seen.set(promptId, agent.name);
      await fs.cp(path.join(promptsDir, promptId), path.join(PROMPTS_OUT, promptId), { recursive: true });
    }
  }

  return seen.size;
}

/**
 * Seeds one tenant with every field the six dispatchable workflows' intake
 * checks read. Mirrors `apps/agent-server/__tests__/test-helpers.ts`'s
 * `setupTestEnvironment()` — that file stays the authority on what a valid
 * client fixture looks like.
 */
async function seedWorkspace(clientSlug: string): Promise<void> {
  const store = new WorkspaceStore(WORKSPACE_OUT);
  const tools = createAllKarosTools(store);

  await store.writeJson(clientSlug, ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS" });
  await store.writeJson(clientSlug, ["client", "voice-rules"], { tone: "confident, no jargon" });
  await store.writeJson(clientSlug, ["client", "brand"], { forbiddenTerms: ["guaranteed", "the best", "#1"] });
  await store.writeJson(clientSlug, ["client", "config"], {
    xHandle: "@acmecorp",
    targetSubreddits: ["smallbusiness", "startups"],
    targetKeywords: ["engineering onboarding", "developer ramp-up time"],
    contentPillars: ["engineering culture", "team operations"],
    targetAudience: "engineering leaders at mid-size B2B SaaS companies",
    frequency: "weekly",
    campaignGoals: "Launch awareness for the new structured-onboarding feature across every channel this quarter.",
  });

  const ctx: AgentContext = { runId: "setup-local-seed", clientSlug, productId: "setup-local", runKind: "recurring", metadata: {} };
  await tools["topics.topUp"]!.execute(
    {
      topics: [
        "structured engineering onboarding",
        "async standups",
        "on-call rotations",
        "code review culture",
        "remote hiring",
        "four-day work weeks",
        "hybrid work anchor days",
        "engineering team retention",
        "developer productivity metrics",
        "technical debt triage",
        "incident response culture",
        "manager 1:1 cadence",
      ],
    },
    { ctx },
  );
}

async function main(): Promise<void> {
  const clientSlug = process.argv[2] ?? "acme";

  const promptCount = await collectPrompts();
  ok(`collected ${promptCount} promptIds into ${path.relative(REPO_ROOT, PROMPTS_OUT)}`);

  await seedWorkspace(clientSlug);
  ok(`seeded tenant "${clientSlug}" into ${path.relative(REPO_ROOT, WORKSPACE_OUT)}`);

  console.log();
  console.log(`${DIM}  Point .env at these two paths (see .env.example), then: npm run dev:server${RESET}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
