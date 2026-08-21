import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, sanitizeSegment, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import type { LandingEngineConfig } from "../config.js";
import { BrandJsonSchema, type BrandJson } from "../types.js";

const TOOL_VERSION = "1.0.0";

export const ReadBundleInputSchema = z.object({});
export type ReadBundleInput = z.infer<typeof ReadBundleInputSchema>;

export interface ReadBundleResult {
  brand: BrandJson;
  intakeMarkdown: string;
  /** Repo-relative paths of client-supplied media found under `<bundle>/assets/` (option A media, AGENT-INVOCATION.md §6). Only populated on the local-disk path — see `readBundleFromWorkspaceStore`'s own doc comment for why the GCS path leaves this empty for now. */
  assetPaths: string[];
  /** Repo-relative paths of the captured old-site screenshots/DOM under `<bundle>/oldSite/`, if any. Same GCS-path limitation as `assetPaths`. */
  oldSiteCapturePaths: string[];
  /** Raw (unvalidated) `feedback-round.json` files found under `<bundle>/feedback/` (FEEDBACK.md §2/§5) — `MODE=rebuild` reads these. Parsing/validating against the round schema is the workflow's job (that schema is agent-package-owned, not this tool package's); a file that isn't valid JSON is skipped rather than failing the whole bundle read. */
  feedbackRounds: Array<{ file: string; data: unknown }>;
}

async function listFilesRecursive(root: string, dir: string = root): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const acc: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Relative to `root`, not `dir` — otherwise a nested file's returned path would be relative
      // to its immediate parent only, dropping every intermediate subdirectory segment.
      acc.push(...(await listFilesRecursive(root, abs)));
    } else if (entry.isFile()) {
      acc.push(path.relative(root, abs));
    }
  }
  return acc;
}

/**
 * Local-disk read (agent-engine#3's original — and still real — behavior):
 * `<bundlesRoot>/<clientSlug>/brand.json` + `intake.md` + `assets/` +
 * `oldSite/` + `feedback/*.json` on whatever disk backs the process. Kept as
 * the offline fallback `createReadBundle` uses when no `WorkspaceStoreLike`
 * is configured — unit tests (`__tests__/fixtures/`) and any composition
 * root that genuinely has no workspace store wired (there is none in this
 * repo's own wiring any more, but a future embedder's is not this package's
 * business to assume).
 */
async function readBundleFromLocalDisk(
  config: LandingEngineConfig,
  clientSlug: string,
): Promise<{ status: "success"; result: ReadBundleResult } | { status: "content_fail"; reason: string }> {
  const bundleRoot = path.join(config.bundlesRoot, sanitizeSegment(clientSlug));

  let brandRaw: string;
  try {
    brandRaw = await fs.readFile(path.join(bundleRoot, "brand.json"), "utf8");
  } catch {
    return { status: "content_fail", reason: `no brand.json found in the input bundle at "${bundleRoot}"` };
  }
  let brandParsed: unknown;
  try {
    brandParsed = JSON.parse(brandRaw);
  } catch (err) {
    return { status: "content_fail", reason: `brand.json in "${bundleRoot}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const brand = BrandJsonSchema.safeParse(brandParsed);
  if (!brand.success) {
    return { status: "content_fail", reason: `brand.json in "${bundleRoot}" does not match the brand contract: ${brand.error.message}` };
  }

  let intakeMarkdown: string;
  try {
    intakeMarkdown = await fs.readFile(path.join(bundleRoot, "intake.md"), "utf8");
  } catch {
    return { status: "content_fail", reason: `no intake.md found in the input bundle at "${bundleRoot}"` };
  }

  const assetPaths = await listFilesRecursive(path.join(bundleRoot, "assets"));
  const oldSiteCapturePaths = await listFilesRecursive(path.join(bundleRoot, "oldSite"));

  const feedbackDir = path.join(bundleRoot, "feedback");
  const feedbackFiles = (await listFilesRecursive(feedbackDir)).filter((f) => f.endsWith(".json"));
  const feedbackRounds: Array<{ file: string; data: unknown }> = [];
  for (const file of feedbackFiles) {
    try {
      feedbackRounds.push({ file, data: JSON.parse(await fs.readFile(path.join(feedbackDir, file), "utf8")) });
    } catch {
      // Not valid JSON — skipped rather than failing the whole bundle read; the workflow's
      // own FeedbackRoundSchema validation is where a genuinely malformed round surfaces.
    }
  }

  return { status: "success", result: { brand: brand.data, intakeMarkdown, assetPaths, oldSiteCapturePaths, feedbackRounds } };
}

/**
 * `WorkspaceStoreLike`-backed read (agent-engine#3's fix) — GCS in a real
 * deployment, so a client's `brand.json`/`intake.md` can be seeded the same
 * way every other agent's client data already is (a plain write to the
 * workspace bucket), instead of only by baking files into the Docker image
 * or exec-ing into the live container.
 *
 * Layout, under the store's own `clients/<clientSlug>/...` convention:
 *   `landing/brand.json`            → `BrandJson` directly (already the
 *                                      natural shape `readJson` returns).
 *   `landing/intake.json`           → `{ markdown: string }` — `intake.md`
 *                                      wrapped in JSON because
 *                                      `WorkspaceStoreLike` only reads/writes
 *                                      JSON documents, never raw text/binary.
 *   `landing/feedback/*.json`       → one feedback round per file, via
 *                                      `listJson` — the store already
 *                                      supports "list every JSON doc under a
 *                                      segment", so this one is a genuine
 *                                      like-for-like port of the legacy
 *                                      `<bundle>/feedback/*.json` layout.
 *
 * `assetPaths`/`oldSiteCapturePaths` are NOT ported to the store path here:
 * `WorkspaceStoreLike` has no arbitrary-file / directory-listing capability
 * (`readJson`/`writeJson`/`listJson` are JSON-document-only), and both
 * fields are optional inputs the workflow only ever lists rather than reads
 * the bytes of. Scoped out deliberately — the gap this closes is "a client's
 * REQUIRED bundle can't be seeded remotely at all," not "every optional
 * bundle input has an equally rich GCS story." Widening `WorkspaceStoreLike`
 * itself (a `listFiles`/raw-bytes capability) is future work if a client
 * bundle genuinely needs remote-seeded media/old-site captures.
 */
async function readBundleFromWorkspaceStore(
  store: WorkspaceStoreLike,
  clientSlug: string,
): Promise<{ status: "success"; result: ReadBundleResult } | { status: "content_fail"; reason: string }> {
  const brandRaw = await store.readJson<unknown>(clientSlug, ["landing", "brand"]);
  if (brandRaw === undefined) {
    return { status: "content_fail", reason: `no landing/brand.json found in the workspace store for client "${clientSlug}"` };
  }
  const brand = BrandJsonSchema.safeParse(brandRaw);
  if (!brand.success) {
    return { status: "content_fail", reason: `landing/brand.json for client "${clientSlug}" does not match the brand contract: ${brand.error.message}` };
  }

  const intakeDoc = await store.readJson<{ markdown?: string }>(clientSlug, ["landing", "intake"]);
  if (intakeDoc === undefined || typeof intakeDoc.markdown !== "string" || intakeDoc.markdown.length === 0) {
    return { status: "content_fail", reason: `no landing/intake.json (with a non-empty "markdown" field) found in the workspace store for client "${clientSlug}"` };
  }

  const feedbackEntries = await store.listJson<unknown>(clientSlug, ["landing", "feedback"]);
  const feedbackRounds = feedbackEntries.map((entry) => ({ file: `${entry.id}.json`, data: entry.data }));

  return {
    status: "success",
    result: { brand: brand.data, intakeMarkdown: intakeDoc.markdown, assetPaths: [], oldSiteCapturePaths: [], feedbackRounds },
  };
}

/**
 * `landing.readBundle` (RFC-07 §4 phase 0 INTAKE / AGENT-INVOCATION.md §1):
 * reads one client's assembled input bundle — `brand.json` (required),
 * `intake.md` (required), `assets/` and `oldSite/` (both optional, listed
 * only). `clientSlug` comes only from `ctx` — the bundle path is never a
 * model-supplied argument, the same tenant-is-structural rule every other
 * tool in this repo follows.
 * A missing/malformed `brand.json` or `intake.md` is a `content_fail`
 * (real, actionable intake-data signal, per RFC-01 §6), never a
 * `tooling_error` — the bundle genuinely isn't ready, which is exactly the
 * `blocked_intake` condition the workflow's step 00 checks for.
 *
 * `workspaceStore`, when supplied, is the PRIMARY source — a real deployment
 * always wires one (see `apps/agent-server/src/wiring/tools.ts`), so
 * `config.bundlesRoot`'s local-disk read only runs when this package is
 * constructed WITHOUT a store at all: unit tests
 * (`__tests__/fixtures/bundles/...`) and any composition root that
 * deliberately omits one. This is the reverse of this tool's pre-#3 default
 * (local disk always, no store option existed) — a real deployment no
 * longer depends on the running container's own filesystem for intake at
 * all.
 */
export function createReadBundle(config: LandingEngineConfig, workspaceStore?: WorkspaceStoreLike) {
  return defineTool<ReadBundleInput, ReadBundleResult>({
    name: "landing.readBundle",
    version: TOOL_VERSION,
    inputSchema: ReadBundleInputSchema,
    async execute(_input, { ctx }) {
      const outcome = workspaceStore
        ? await readBundleFromWorkspaceStore(workspaceStore, ctx.clientSlug)
        : await readBundleFromLocalDisk(config, ctx.clientSlug);
      return outcome.status === "success" ? success(outcome.result) : contentFail<ReadBundleResult>(outcome.reason);
    },
  });
}
