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
import { PROMPT_REGISTRY, REPO_ROOT, promptVersionPath, type PromptRegistryEntry } from "./prompt-registry";

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
  /** The registry entry this was loaded from — the declared, reviewed truth about ids/versions/owner. */
  registry: PromptRegistryEntry;
}

/**
 * SCRUM-325: loads exactly what `scripts/prompt-registry.ts` DECLARES, by
 * path, instead of walking `agents/` and publishing whatever turned up.
 *
 * The walk this replaced could not disagree with the disk, so an unnumbered
 * `latest.md`, a stray directory or a promptId that had quietly changed owner
 * all published as if intended. The registry is a second, reviewed statement
 * of the same facts; `npm run check:prompts` is what forces the two to agree,
 * and it runs as its own job in quality.yml BEFORE any deploy publishes. This
 * function therefore fails on a missing file rather than skipping it — a
 * registry entry with no file on disk is a checked-in mistake, not an
 * optional prompt.
 */
async function loadRegisteredPrompts(): Promise<PromptToPublish[]> {
  const prompts: PromptToPublish[] = [];
  for (const entry of PROMPT_REGISTRY) {
    const versions = new Map<string, string>();
    for (const version of entry.versions) {
      const file = promptVersionPath(entry, version);
      try {
        versions.set(version, await fs.readFile(file, "utf8"));
      } catch (err) {
        throw new Error(
          `publish-prompts: PROMPT_REGISTRY declares "${entry.promptId}@${version}" but ${path.relative(REPO_ROOT, file)} ` +
            `could not be read (${err instanceof Error ? err.message : String(err)}). ` +
            "Run `npm run check:prompts` — the registry and the repo disagree.",
        );
      }
    }
    const latestPath = path.join(REPO_ROOT, "agents", entry.agent, "prompts", entry.promptId, "latest.md");
    const latestContent = await fs.readFile(latestPath, "utf8");
    prompts.push({ promptId: entry.promptId, agent: entry.agent, versions, latestContent, registry: entry });
  }
  return prompts;
}

/**
 * Which version `prompts/{promptId}.latestVersion` is published as — the
 * registry's declared `latestVersion`, VERIFIED byte-for-byte against
 * `latest.md`, and a hard failure when they disagree.
 *
 * SCRUM-325 replaced what used to be here. The old version matched
 * `latest.md` by content against the numbered files and, when nothing
 * matched, SYNTHESIZED a new version one past the highest number, published
 * `latest.md`'s text under it, and repointed `latestVersion` at the invention
 * — with a dimmed `console.warn` and exit code 0. It ran that path against
 * real prep and prod: `blog-craft` and `newsletter-craft` both had a
 * `latest.md` matching none of their numbered versions, so a phantom `v4`
 * was minted for each, out of text no numbered file in git ever contained.
 * A publisher that invents the thing it cannot find has no failure mode; it
 * always "succeeds", and the drift it was papering over is exactly the drift
 * someone needed to be told about.
 *
 * So it refuses. `npm run check:prompts` catches the same condition in CI,
 * before a deploy, with a better message; this is the last line, for a
 * publish run by hand against prod.
 */
function resolveLatestVersion(prompt: PromptToPublish): string {
  const declared = prompt.registry.latestVersion;
  const declaredContent = prompt.versions.get(declared);
  if (declaredContent === undefined) {
    throw new Error(
      `publish-prompts: "${prompt.promptId}" (${prompt.agent}): PROMPT_REGISTRY declares latestVersion "${declared}", ` +
        `which is not among its declared versions [${prompt.registry.versions.join(", ")}]. ` +
        "Fix scripts/prompt-registry.ts — nothing is published until the registry is self-consistent.",
    );
  }
  if (declaredContent !== prompt.latestContent) {
    const matches = [...prompt.versions.entries()].filter(([, content]) => content === prompt.latestContent).map(([v]) => v);
    throw new Error(
      `publish-prompts: "${prompt.promptId}" (${prompt.agent}): latest.md is not byte-identical to its declared ` +
        `latestVersion ${declared}.md — ` +
        (matches.length > 0
          ? `it matches ${matches.map((v) => `${v}.md`).join(", ")}. `
          : "it matches no numbered version at all. ") +
        "Snapshot latest.md as a new numbered version and update scripts/prompt-registry.ts, or re-sync latest.md. " +
        "This script no longer invents a version to publish it under. Nothing has been written for this prompt.",
    );
  }
  return declared;
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

  // Only `src/` — a real pin that governs a real deploy only ever lives in
  // an agent's own BaseAgent config. `__tests__`/`evals` deliberately pin
  // nonsense skillRefs like "does-not-exist@99" to exercise the "agent
  // fails gracefully on an unresolvable skillRef" path, and that string
  // must never gate a deploy the way a real pin should.
  async function scanDir(dir: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__" || entry.name === "evals") continue;
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

  const prompts = await loadRegisteredPrompts();
  ok(`loaded ${prompts.length} registered promptIds across ${new Set(prompts.map((p) => p.agent)).size} agents`);

  // Resolve EVERY prompt's latestVersion before opening Firestore. Resolution
  // now refuses on drift instead of inventing a version, and a refusal
  // halfway through the write loop would leave prep/prod half-published —
  // some prompts on their new content, the rest on their old. Validate the
  // whole set first, write nothing until all of it is valid.
  const latestVersions = new Map(prompts.map((prompt) => [prompt.promptId, resolveLatestVersion(prompt)]));
  ok(`latest.md verified byte-identical to the registry's declared latestVersion for all ${prompts.length} prompts`);

  const app = initializeApp({ credential: applicationDefault(), projectId: project });
  const db = getFirestore(app, databaseId);

  let versionDocsWritten = 0;
  for (const prompt of prompts) {
    const latestVersion = latestVersions.get(prompt.promptId)!;
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
  // Every version the registry declares was just published above,
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
