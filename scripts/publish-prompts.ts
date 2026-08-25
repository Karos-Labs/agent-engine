/**
 * Publishes every agent's `prompts/<promptId>/{N.md,latest.md}` files (the
 * same files `setup-local.ts` merges into a local `FilePromptStore` root)
 * into the real `FirestorePromptStore` layout: a `prompts/{promptId}` doc
 * holding `{ latestVersion }`, and one `promptVersions/{promptId}@{version}`
 * doc per numbered version holding `{ content }` (see
 * `packages/core/src/agent/firestore-prompt-store.ts`'s own doc comment).
 *
 * WHY THIS SCRIPT EXISTS: prompts ship per-agent in this repo
 * (`agents/<agent>/prompts/`) and are read from local disk in dev via
 * `setup-local.ts`'s merge step — but nothing published them to Firestore
 * for a real deployment where `PROMPT_STORE_DRIVER=firestore` (prep/prod's
 * actual configuration). Every `skillRef`-resolving AI step in every fixed
 * product agent was failing with "no prompt version found" until this ran —
 * found live, in prep, 2026-08-21, dispatching a real `instagram-agent` run.
 *
 * Idempotent: re-running overwrites the same docs with the same content, no
 * different than running it once. Safe to run against prep or prod as often
 * as prompts change — this IS the publish step until a CI job does it.
 *
 * Run with (from the repo root):
 *   GOOGLE_CLOUD_PROJECT=karoscmo FIRESTORE_DATABASE_ID=prep npx tsx scripts/publish-prompts.ts
 *   GOOGLE_CLOUD_PROJECT=karoscmo FIRESTORE_DATABASE_ID="(default)" npx tsx scripts/publish-prompts.ts   # prod
 *
 * Credentials: Application Default Credentials (gcloud auth application-default login,
 * or Workload Identity in CI) — same as every other one-off script in this repo.
 *
 * KNOWN FLAKE: this repo's pinned `google-auth-library` (10.9.1 at the time
 * this script was added) intermittently threw `UNKNOWN: Getting metadata
 * from plugin failed... Premature close` fetching an OAuth2 token, on every
 * Firestore write, from a machine where `gcloud` itself authenticates fine.
 * A sibling repo pinned to `google-auth-library@11.0.2` ran the identical
 * logic against the identical project/database without a single failure —
 * so if this keeps flaking, the fastest workaround is running the same
 * discover-and-publish logic from an environment with a newer
 * `google-auth-library`, rather than assuming the credentials/network are
 * actually broken.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// scripts/*.ts compiles as CommonJS under the root tsconfig — see setup-local.ts's own note.
const REPO_ROOT = path.resolve(__dirname, "..");

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
function ok(msg: string): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

interface PromptToPublish {
  promptId: string;
  agent: string;
  versions: Map<string, string>; // version string -> content
  latestContent: string;
}

/** Same traversal as setup-local.ts's `collectPrompts()` — fails loudly on a promptId collision across agents, the same "one shared PromptStore, no ambiguity" rule. */
async function discoverPrompts(): Promise<PromptToPublish[]> {
  const agentsDir = path.join(REPO_ROOT, "agents");
  const seen = new Map<string, string>();
  const prompts: PromptToPublish[] = [];

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
          `publish-prompts: promptId "${promptId}" is shipped by both "${previousOwner}" and "${agent.name}" — ` +
            "one shared PromptStore can't serve both. Rename one of them before publishing.",
        );
      }
      seen.set(promptId, agent.name);

      const dir = path.join(promptsDir, promptId);
      const files = await fs.readdir(dir);
      const versions = new Map<string, string>();
      for (const file of files) {
        const m = /^(\d+)\.md$/.exec(file);
        if (m) versions.set(m[1]!, await fs.readFile(path.join(dir, file), "utf8"));
      }
      const latestContent = await fs.readFile(path.join(dir, "latest.md"), "utf8");
      prompts.push({ promptId, agent: agent.name, versions, latestContent });
    }
  }
  return prompts;
}

/**
 * Which version `prompts/{promptId}.latestVersion` should point at — matched
 * by CONTENT against the numbered files first, never assumed to be "the
 * highest number." When nothing matches (a real, observed case: `blog-craft`'s
 * `latest.md` has been edited ahead of its last numbered snapshot — an
 * un-versioned, in-progress iteration, not a data-entry error), `latest.md`'s
 * own content is published as a NEW synthesized version one past the highest
 * existing number, so `latestVersion` always points at a real
 * `promptVersions` doc rather than being orphaned or silently wrong. Mutates
 * `prompt.versions` to add that synthesized entry — the caller's write loop
 * picks it up automatically.
 */
function resolveLatestVersion(prompt: PromptToPublish): string {
  for (const [version, content] of prompt.versions) {
    if (content === prompt.latestContent) return version;
  }
  const highest = Math.max(0, ...[...prompt.versions.keys()].map(Number));
  const synthesized = String(highest + 1);
  console.warn(
    `  ${DIM}⚠ "${prompt.promptId}" (${prompt.agent}): latest.md matches none of its numbered versions ` +
      `(${[...prompt.versions.keys()].join(", ")}) — publishing it as a new version "${synthesized}".${RESET}`,
  );
  prompt.versions.set(synthesized, prompt.latestContent);
  return synthesized;
}

/**
 * Retries a flaky Firestore write. The known failure here isn't Firestore
 * being down — it's this repo's pinned `google-auth-library` intermittently
 * throwing `Premature close` fetching an OAuth2 token, on a machine where
 * `gcloud` itself and a newer `google-auth-library` (a sibling repo's, e.g.)
 * authenticate fine every time (see this file's own "KNOWN FLAKE" note
 * above). A short retry costs nothing on the common case and turns the
 * uncommon one into a non-event instead of a failed publish.
 */
async function withRetry<T>(label: string, attempt: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      if (i < attempts) {
        console.warn(`  ${DIM}⚠ ${label}: attempt ${i}/${attempts} failed (${err instanceof Error ? err.message : String(err)}), retrying...${RESET}`);
        await new Promise((r) => setTimeout(r, 500 * i));
      }
    }
  }
  throw lastError;
}

/**
 * Every `skillRef: "promptId@version"` pin actually present in agent source
 * — a plain string scan, not a TS import, so this script has no compile-time
 * dependency on any agent package. This is the check that would have caught
 * both real incidents this guarded against before a deploy ever went out:
 * code pinned to a version that was never published, twice, because
 * publishing was a manual step nobody remembered to run after bumping a
 * skillRef. Scanning what's ACTUALLY pinned in code — rather than only
 * publishing whatever happens to be numbered on disk — is what makes this
 * check general over every promptId that exists now or is added later,
 * not a list of known names to keep in sync by hand.
 */
async function findPinnedSkillRefs(): Promise<Array<{ promptId: string; version: string; file: string }>> {
  const agentsDir = path.join(REPO_ROOT, "agents");
  const pins: Array<{ promptId: string; version: string; file: string }> = [];
  const pattern = /skillRef:\s*["']([a-zA-Z0-9_-]+)@(\d+)["']/g;

  async function scanDir(dir: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(full);
      } else if (entry.name.endsWith(".ts")) {
        const content = await fs.readFile(full, "utf8");
        for (const match of content.matchAll(pattern)) {
          pins.push({ promptId: match[1]!, version: match[2]!, file: path.relative(REPO_ROOT, full) });
        }
      }
    }
  }
  await scanDir(agentsDir);
  return pins;
}

async function main(): Promise<void> {
  const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  if (!project) throw new Error("publish-prompts: GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT) must be set");
  const databaseId = process.env.FIRESTORE_DATABASE_ID ?? "(default)";

  const prompts = await discoverPrompts();
  ok(`discovered ${prompts.length} promptIds across ${new Set(prompts.map((p) => p.agent)).size} agents`);

  const app = initializeApp({ credential: applicationDefault(), projectId: project });
  const db = getFirestore(app, databaseId);

  let versionDocsWritten = 0;
  for (const prompt of prompts) {
    const latestVersion = resolveLatestVersion(prompt);
    await withRetry(`prompts/${prompt.promptId}`, () => db.collection("prompts").doc(prompt.promptId).set({ latestVersion }));
    for (const [version, content] of prompt.versions) {
      await withRetry(`promptVersions/${prompt.promptId}@${version}`, () =>
        db.collection("promptVersions").doc(`${prompt.promptId}@${version}`).set({ content }),
      );
      versionDocsWritten++;
    }
    ok(`published "${prompt.promptId}" (latest: ${latestVersion}, ${prompt.versions.size} version(s)) → database "${databaseId}"`);
  }

  console.log();
  console.log(`${DIM}  ${prompts.length} prompts, ${versionDocsWritten} version docs written to project "${project}" database "${databaseId}".${RESET}`);

  // Fail loudly, after publishing, if any pin in code would not resolve.
  // Every version discoverPrompts() found on disk was just published above,
  // so this passes for a normal bump and only trips when a skillRef points
  // at a version whose file was never created at all — the one remaining
  // way this class of outage could still happen.
  console.log();
  const pins = await findPinnedSkillRefs();
  const versionsByPromptId = new Map(prompts.map((p) => [p.promptId, p.versions]));
  const unresolved = pins.filter((pin) => !versionsByPromptId.get(pin.promptId)?.has(pin.version));
  if (unresolved.length > 0) {
    console.error("ERROR: the following skillRef pins will not resolve — the numbered .md file was never created:");
    for (const pin of unresolved) {
      console.error(`  ${pin.file}: "${pin.promptId}@${pin.version}"`);
    }
    throw new Error(`${unresolved.length} unpublishable skillRef pin(s) — see above`);
  }
  ok(`verified ${pins.length} skillRef pin(s) across agent source all resolve to a published version`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
